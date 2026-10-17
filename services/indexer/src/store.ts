/**
 * The indexer's state: both Merkle trees rebuilt leaf by leaf from
 * events, plus lookup tables for bindings and latest census snapshots.
 *
 * Storage is in-memory with an optional JSON snapshot on disk — the
 * whole store is rebuildable from chain data at any time, which is the
 * point: this service carries no trust (threat model). A Postgres
 * adapter is a deployment option tracked for M2 (docs/adr/0001).
 *
 * Every tree append is checked BEFORE it happens: an event whose index
 * or root does not chain leaves the store untouched, and a redelivery of
 * a leaf already present is a no-op — so neither a webhook retry nor an
 * overlapping poll can leave a phantom leaf behind.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FieldElement, IncrementalTree, ROOT_HISTORY_SIZE, bytes32ToField } from "@ghostlink/common";
import type { GhostLinkEvent } from "@ghostlink/service-kit";

export interface CensusEntry {
  leafIndex: number;
  wallet: string;
  mint: string;
  amount: string;
  slot: string;
}

export interface BindingEntry {
  leafIndex: number;
  commitmentHex: string;
}

export interface PocketEntry {
  pocket: string;
  appIdHex: string;
  createdAt: string; // ISO time of first SessionOpened seen
  sessionExpirySlot: string;
  revoked: boolean;
  sweptHomeTo?: string;
  pendingChangeAfterSlot?: string;
}

export interface ActivityEntry {
  pocket: string;
  kind: string;
  at: string; // ISO ingest time (block time is the explorer's job)
  detail: Record<string, string>;
}

export interface Snapshot {
  registryLeaves: string[];
  censusLeaves: string[];
  bindings: Record<string, BindingEntry>;
  census: Record<string, CensusEntry>;
  pockets?: Record<string, PocketEntry>;
  activity?: ActivityEntry[];
  /** program id -> newest fully processed signature (poller cursors). */
  cursors?: Record<string, string>;
  processedTransactions?: string[];
}

export class IndexerStore {
  registry = new IncrementalTree();
  census = new IncrementalTree();
  /** Decimal leaf values in append order — the persistence source of truth. */
  registryLeaves: string[] = [];
  censusLeaves: string[] = [];
  /** wallet base58 -> binding */
  bindings = new Map<string, BindingEntry>();
  /** `${wallet}:${mint}` -> latest snapshot */
  latestCensus = new Map<string, CensusEntry>();
  /** pocket address base58 -> live state from pocket-program events */
  pockets = new Map<string, PocketEntry>();
  /** newest last; capped so the store stays rebuildable-light */
  activity: ActivityEntry[] = [];
  registryRoots: FieldElement[] = [];
  censusRoots: FieldElement[] = [];
  /** Poller cursors, persisted with the snapshot. */
  cursors = new Map<string, string>();
  private processedTransactions = new Set<string>();

  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly persistPath?: string, private readonly saveCheckpoint?: (snapshot: Snapshot) => void) {}

  snapshot(): Snapshot {
    return { registryLeaves: this.registryLeaves, censusLeaves: this.censusLeaves,
      bindings: Object.fromEntries(this.bindings), census: Object.fromEntries(this.latestCensus),
      pockets: Object.fromEntries(this.pockets), activity: this.activity,
      cursors: Object.fromEntries(this.cursors), processedTransactions: [...this.processedTransactions] };
  }

  restore(snap: Snapshot): void {
    this.registry = new IncrementalTree(); this.census = new IncrementalTree();
    this.registryLeaves = []; this.censusLeaves = []; this.registryRoots = []; this.censusRoots = [];
    for (const leaf of snap.registryLeaves) { this.registry.append(BigInt(leaf)); this.registryLeaves.push(leaf); this.registryRoots.push(this.registry.root); }
    for (const leaf of snap.censusLeaves) { this.census.append(BigInt(leaf)); this.censusLeaves.push(leaf); this.censusRoots.push(this.census.root); }
    this.registryRoots = this.registryRoots.slice(-ROOT_HISTORY_SIZE); this.censusRoots = this.censusRoots.slice(-ROOT_HISTORY_SIZE);
    this.bindings = new Map(Object.entries(snap.bindings)); this.latestCensus = new Map(Object.entries(snap.census));
    this.pockets = new Map(Object.entries(snap.pockets ?? {})); this.activity = snap.activity ?? [];
    this.cursors = new Map(Object.entries(snap.cursors ?? {})); this.processedTransactions = new Set(snap.processedTransactions ?? []);
  }

  /** One transaction's events and cursor updates commit together; failure restores the last complete state. */
  checkpointTransaction(signature: string, events: GhostLinkEvent[], programs: string[], commit: (snapshot: Snapshot) => void): number {
    const before = JSON.stringify(this.snapshot());
    try {
      const applied = this.applyTransaction(signature, events);
      for (const program of programs) this.setCursor(program, signature);
      commit(this.snapshot());
      return applied;
    } catch (error) { this.restore(JSON.parse(before) as Snapshot); throw error; }
    finally { if (this.persistTimer) clearTimeout(this.persistTimer); this.persistTimer = null; }
  }

  /** Deduplicate whole transactions across polling, webhook retries and restarts. */
  applyTransaction(signature: string, events: GhostLinkEvent[]): number {
    if (this.processedTransactions.has(signature)) return 0;
    let applied = 0;
    for (const event of events) if (this.apply(event)) applied += 1;
    if (events.length) {
      this.processedTransactions.add(signature);
      this.persist();
    }
    return applied;
  }

  /** Applies one event. Returns false when it was a harmless redelivery. */
  apply(event: GhostLinkEvent): boolean {
    switch (event.kind) {
      case "Registered": {
        const { index, duplicate } = this.appendChecked("registry", event.leaf, Number(event.leafIndex), event.root);
        if (duplicate) return false;
        this.bindings.set(event.wallet, {
          leafIndex: index,
          commitmentHex: Buffer.from(event.commitment).toString("hex"),
        });
        break;
      }
      case "SnapshotTaken": {
        const { index, duplicate } = this.appendChecked("census", event.leaf, Number(event.leafIndex), event.root);
        if (duplicate) return false;
        this.latestCensus.set(`${event.wallet}:${event.mint}`, {
          leafIndex: index,
          wallet: event.wallet,
          mint: event.mint,
          amount: event.amount.toString(),
          slot: event.slot.toString(),
        });
        break;
      }
      case "SessionOpened": {
        const appIdHex = Buffer.from(event.appId).toString("hex");
        const existing = this.pockets.get(event.pocket);
        this.pockets.set(event.pocket, {
          pocket: event.pocket,
          appIdHex,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          sessionExpirySlot: event.sessionExpirySlot.toString(),
          revoked: false,
          sweptHomeTo: existing?.sweptHomeTo,
          pendingChangeAfterSlot: existing?.pendingChangeAfterSlot,
        });
        this.note(event.pocket, "SessionOpened", {
          created: String(event.created),
          expirySlot: event.sessionExpirySlot.toString(),
        });
        break;
      }
      case "Filled": {
        this.note(event.pocket, "Filled", {
          inMint: event.inMint,
          inMax: event.inMax.toString(),
          outMint: event.outMint,
          outReceived: event.outReceived.toString(),
          usdE6: event.inValueUsdE6.toString(),
          mode: event.mode.toString(),
          releasedCostUsdE6: event.releasedCostUsdE6.toString(),
        });
        break;
      }
      case "SweptHome": {
        const p = this.pockets.get(event.pocket);
        if (p) p.sweptHomeTo = event.home;
        this.note(event.pocket, "SweptHome", { home: event.home });
        break;
      }
      case "SessionRevoked": {
        const p = this.pockets.get(event.pocket);
        if (p) p.revoked = true;
        this.note(event.pocket, "SessionRevoked", {});
        break;
      }
      case "ChangeProposed": {
        const p = this.pockets.get(event.pocket);
        if (p) p.pendingChangeAfterSlot = event.executableAfterSlot.toString();
        this.note(event.pocket, "ChangeProposed", {
          executableAfterSlot: event.executableAfterSlot.toString(),
        });
        break;
      }
      case "ChangeExecuted":
      case "ChangeCanceled": {
        const p = this.pockets.get(event.pocket);
        if (p) p.pendingChangeAfterSlot = undefined;
        this.note(event.pocket, event.kind, {});
        break;
      }
      default:
        return false;
    }
    this.persist();
    return true;
  }

  setCursor(program: string, signature: string): void {
    this.cursors.set(program, signature);
    this.persist();
  }

  private note(pocket: string, kind: string, detail: Record<string, string>): void {
    this.activity.push({ pocket, kind, at: new Date().toISOString(), detail });
    if (this.activity.length > 5000) this.activity.splice(0, this.activity.length - 5000);
  }

  pocketByAppId(appIdHex: string): PocketEntry | undefined {
    for (const p of this.pockets.values()) {
      if (p.appIdHex === appIdHex.toLowerCase()) return p;
    }
    return undefined;
  }

  activityFor(pocket: string, limit = 50): ActivityEntry[] {
    const out: ActivityEntry[] = [];
    for (let i = this.activity.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.activity[i]!.pocket === pocket) out.push(this.activity[i]!);
    }
    return out;
  }

  /**
   * Checks index and root against the event BEFORE touching the tree.
   * Redelivery of an identical leaf is reported as a duplicate; a
   * different leaf at an existing index, a gap, or a root that does not
   * chain is refused with the tree unchanged.
   */
  private appendChecked(
    kind: "registry" | "census",
    leafBytes: Uint8Array,
    eventIndex: number,
    rootBytes: Uint8Array,
  ): { index: number; duplicate: boolean } {
    const tree = kind === "registry" ? this.registry : this.census;
    const leaf = bytes32ToField(leafBytes);
    const root = bytes32ToField(rootBytes);
    const next = tree.nextIndex;
    if (eventIndex < next) {
      if (tree.leafAt(eventIndex) === leaf) return { index: eventIndex, duplicate: true };
      throw new Error(
        `${kind} leaf ${eventIndex} is already present with different contents — refusing to diverge from the chain`,
      );
    }
    if (eventIndex > next) {
      throw new Error(`${kind} leaf gap: event says ${eventIndex}, tree is at ${next} — an earlier event is missing`);
    }
    if (tree.rootAfterAppend(leaf) !== root) {
      throw new Error(`${kind} root mismatch: the event's root does not chain from this tree — refused`);
    }
    tree.append(leaf);
    const leaves = kind === "registry" ? this.registryLeaves : this.censusLeaves;
    const roots = kind === "registry" ? this.registryRoots : this.censusRoots;
    leaves.push(leaf.toString());
    roots.push(tree.root);
    if (roots.length > ROOT_HISTORY_SIZE * 2) roots.splice(0, roots.length - ROOT_HISTORY_SIZE);
    return { index: next, duplicate: false };
  }

  recentRoots(kind: "registry" | "census", limit = ROOT_HISTORY_SIZE): string[] {
    const roots = kind === "registry" ? this.registryRoots : this.censusRoots;
    return roots.slice(-limit).map((r) => r.toString());
  }

  /** Debounced, atomic snapshot write (temp file + rename). */
  private persist(): void {
    if (this.saveCheckpoint || !this.persistPath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, 250);
    this.persistTimer.unref?.();
  }

  flush(): void {
    if (this.saveCheckpoint) { this.saveCheckpoint(this.snapshot()); return; }
    if (!this.persistPath) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const snapshot = this.snapshot();
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const tmp = `${this.persistPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, this.persistPath);
  }

  /**
   * Loads a snapshot. A missing file starts empty; a corrupt one throws,
   * because silently starting over would make the store disagree with
   * every client that already trusted its roots.
   */
  static load(persistPath?: string): IndexerStore {
    const store = new IndexerStore(persistPath);
    if (!persistPath || !existsSync(persistPath)) return store;
    const snap = JSON.parse(readFileSync(persistPath, "utf8")) as Snapshot;
    store.restore(snap);
    return store;
  }
}
