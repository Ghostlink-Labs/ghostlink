/** Scoped persistent scan spool and atomic derived-state checkpoint. Public RPC history never becomes executable input. */
import { createHash, randomBytes } from "node:crypto";
import { EncryptedSqlite } from "@ghostlink/service-kit/storage";
import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import { IndexerStore, type Snapshot } from "./store.js";

export interface Scan { upperSlot: number; programs: string[]; nextProgram: number;
  counts: Record<SpoolTable, number>;
  positions: Record<string, { until?: string; before?: string; previous?: { signature: string; slot: number }; done: boolean }> }
const spoolTables = ["pending", "members", "scanned", "edges"] as const;
type SpoolTable = typeof spoolTables[number];
const emptyCounts = () => ({ pending: 0, members: 0, scanned: 0, edges: 0 });
export interface Pending { signature: string; slot: number; failed: boolean; programs: string[] }
const slotValue = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid indexer slot"); return n; };
const signatureValue = (s: string) => { if (typeof s !== "string" || !s.length || s.length > 128) throw new Error("invalid indexer signature"); return s; };

export class IndexerDatabase {
  #storage: EncryptedSqlite;
  #namespace: string;
  #token = randomBytes(32).toString("hex");
  #closed = false;
  #openedInstanceId!: string;
  constructor(path: string, key: Uint8Array, scope: string, private readonly clock = Date.now,
    private readonly maximumPending = 1_000_000, private readonly maximumSlot = 4096, expectedId?: string) {
    if (!scope || !Number.isSafeInteger(maximumPending) || maximumPending < 1 || !Number.isSafeInteger(maximumSlot) || maximumSlot < 1) throw new Error("invalid indexer storage limits");
    this.#namespace = "ghostlink:indexer:v1:" + createHash("sha256").update(scope).digest("hex");
    this.#storage = new EncryptedSqlite(path, key, this.#namespace, { existing: expectedId !== undefined });
    try {
      if (this.#storage.recoveryId) throw new Error("restored indexer requires independently reconciled history");
      this.#storage.transaction(() => {
        if (expectedId === undefined && !this.#storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state'").get()) {
          this.#storage.db.exec(`CREATE TABLE state (name TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS pending (signature TEXT PRIMARY KEY, slot INTEGER NOT NULL, failed INTEGER NOT NULL) STRICT;
          CREATE INDEX IF NOT EXISTS pending_slot ON pending(slot);
          CREATE TABLE IF NOT EXISTS members (program TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(program,signature)) STRICT;
          CREATE INDEX IF NOT EXISTS members_signature ON members(signature);
          CREATE TABLE IF NOT EXISTS scanned (program TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(program,signature)) STRICT;
          CREATE TABLE IF NOT EXISTS edges (older TEXT NOT NULL, newer TEXT NOT NULL, PRIMARY KEY(older,newer)) STRICT;
          CREATE INDEX IF NOT EXISTS edges_newer ON edges(newer);`);
          this.#storage.db.prepare("INSERT INTO metadata VALUES ('indexer-instance-v1', ?)")
            .run(this.#storage.seal(Buffer.from(randomBytes(32).toString("hex")), this.#namespace + ":instance:v1"));
          this.#put("snapshot", new IndexerStore().snapshot()); this.#put("through", 0); this.#put("scan", null);
        }
        // Never recreate missing hosted schema or silently upgrade legacy checkpoint state.
        this.#storage.db.prepare("SELECT name,data FROM state LIMIT 0").all();
        this.#storage.db.prepare("SELECT signature,slot,failed FROM pending LIMIT 0").all();
        this.#storage.db.prepare("SELECT program,signature FROM members LIMIT 0").all();
        this.#storage.db.prepare("SELECT program,signature FROM scanned LIMIT 0").all();
        this.#storage.db.prepare("SELECT older,newer FROM edges LIMIT 0").all();
        const id = this.instanceId;
        if (!id || (expectedId !== undefined && id !== expectedId)) throw new Error("indexer state identity mismatch");
        this.#checkpoint(); this.#verifySpool();
        this.#openedInstanceId = id; // Check identity and continuity before acquiring a lease.
        const lease = this.#get<{ token: string; until: number }>("lease");
        if (lease && lease.until > this.clock()) throw new Error("indexer state is already owned by another worker");
        this.#put("lease", { token: this.#token, until: this.clock() + 90_000 });
      });
    } catch (error) { this.#storage.close(); throw error; }
  }
  get instanceId(): string | undefined {
    const row = this.#storage.db.prepare("SELECT value FROM metadata WHERE name='indexer-instance-v1'").get();
    if (!row) return;
    const plain = this.#storage.open(row.value as Uint8Array, this.#namespace + ":instance:v1");
    try { const id = plain.toString(); if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid indexer state identity"); return id; }
    finally { plain.fill(0); }
  }
  static openExisting(path: string, key: Uint8Array, scope: string, expectedId: string, clock = Date.now): IndexerDatabase {
    if (typeof expectedId !== "string" || !/^[0-9a-f]{64}$/.test(expectedId)) throw new Error("expected indexer state identity required");
    return new IndexerDatabase(path, key, scope, clock, 1_000_000, 4096, expectedId);
  }
  #checkpoint(): Snapshot {
    const snapshot = this.#get<Snapshot>("snapshot");
    if (!snapshot || !Array.isArray(snapshot.registryLeaves) || !Array.isArray(snapshot.censusLeaves) ||
      !Array.isArray(snapshot.activity) || !Array.isArray(snapshot.processedTransactions) ||
      [snapshot.bindings, snapshot.census, snapshot.pockets, snapshot.cursors].some(value => !value || typeof value !== "object" || Array.isArray(value))) {
      throw new Error("indexer snapshot is missing or incomplete");
    }
    return snapshot;
  }
  #verifySpool(): void {
    const through = this.#get<number>("through"), scan = this.#get<Scan | null>("scan");
    if (through === undefined || scan === undefined) throw new Error("indexer progress checkpoint is missing");
    slotValue(through);
    if (scan !== null && (!scan.counts || !Array.isArray(scan.programs) || !scan.programs.length ||
      !Number.isInteger(scan.nextProgram) || scan.nextProgram < 0 || scan.nextProgram > scan.programs.length ||
      slotValue(scan.upperSlot) < through || !scan.positions || scan.programs.some(program => !scan.positions[program]))) throw new Error("invalid indexer scan checkpoint");
    for (const table of spoolTables) {
      const expected = scan === null ? 0 : scan.counts[table];
      const actual = Number(this.#storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
      if (!Number.isSafeInteger(expected) || expected < 0 || actual !== expected) throw new Error("indexer spool history is missing or inconsistent");
    }
  }
  #get<T>(name: string): T | undefined {
    const row = this.#storage.db.prepare("SELECT data FROM state WHERE name=?").get(name); if (!row) return;
    const bytes = this.#storage.open(row.data as Uint8Array, `${this.#namespace}:${name}`);
    try { return JSON.parse(bytes.toString()) as T; } finally { bytes.fill(0); }
  }
  #put(name: string, value: unknown): void {
    const bytes = Buffer.from(JSON.stringify(value));
    try {
      if (bytes.length > 64 * 1024 * 1024) throw new Error("indexer checkpoint exceeds configured storage envelope");
      this.#storage.db.prepare("INSERT INTO state VALUES (?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data").run(name, this.#storage.seal(bytes, `${this.#namespace}:${name}`));
    } finally { bytes.fill(0); }
  }
  #owned(): void {
    if (this.instanceId !== this.#openedInstanceId || this.#storage.recoveryId) throw new Error("indexer state identity or restore state changed");
    if (this.#storage.db.prepare("SELECT COUNT(*) AS n FROM state WHERE name IN ('snapshot','through','scan')").get()!.n !== 3) throw new Error("indexer checkpoint is missing");
    const lease = this.#get<{ token: string; until: number }>("lease"), now = this.clock();
    if (!Number.isSafeInteger(now) || !lease || lease.token !== this.#token || lease.until <= now) throw new Error("indexer ownership lease lost");
  }
  assertOwned(): void { this.#owned(); this.#verifySpool(); }
  renew(): void { this.#storage.transaction(() => { this.assertOwned(); this.#put("lease", { token: this.#token, until: this.clock() + 90_000 }); }); }
  close(): void {
    if (this.#closed) return;
    try { this.#storage.transaction(() => { if (this.#get<{ token: string }>("lease")?.token === this.#token) this.#storage.db.prepare("DELETE FROM state WHERE name='lease'").run(); }); }
    finally { this.#closed = true; this.#storage.close(); }
  }
  snapshot(): Snapshot { this.#owned(); return this.#checkpoint(); }
  save(snapshot: Snapshot): void { this.#storage.transaction(() => { this.#owned(); this.#put("snapshot", snapshot); }); }
  scan(): Scan | undefined { this.#owned(); return this.#get<Scan | null>("scan") ?? undefined; }
  through(): number { this.#owned(); return slotValue(this.#get<number>("through")!); }
  pending(): number { this.#owned(); return Number(this.#storage.db.prepare("SELECT COUNT(*) AS n FROM pending").get()!.n); }
  begin(upperSlot: number, programs: string[], cursors: Map<string, string>): void {
    this.#storage.transaction(() => {
      this.assertOwned(); slotValue(upperSlot);
      if (this.scan() || this.pending()) throw new Error("indexer scan already active");
      if (upperSlot < this.through()) throw new Error("indexer chain head regressed");
      this.#put("scan", { upperSlot, programs, nextProgram: 0, counts: emptyCounts(),
        positions: Object.fromEntries(programs.map(p => [p, { until: cursors.get(p), done: false }])) } satisfies Scan);
    });
  }
  page(program: string, before: string | undefined, page: ConfirmedSignatureInfo[], limit: number): void {
    this.#storage.transaction(() => {
      this.assertOwned(); const scan = this.scan();
      if (!scan || scan.programs[scan.nextProgram] !== program) throw new Error("indexer scan changed");
      const position = scan.positions[program]!;
      if (position.before !== before || position.done || !Array.isArray(page) || page.length > limit) throw new Error("invalid indexer page boundary");
      let previous = position.previous, reached = false;
      let pendingCount = this.pending(), scannedCount = Number(this.#storage.db.prepare("SELECT COUNT(*) AS n FROM scanned").get()!.n);
      const seen = new Set<string>();
      for (const info of page) {
        signatureValue(info.signature); slotValue(info.slot);
        if (info.err === undefined || seen.has(info.signature) || info.signature === before || (previous && info.slot > previous.slot)) throw new Error("inconsistent or repeated indexer page");
        seen.add(info.signature);
        if (info.signature === position.until) { reached = true; break; }
        if (this.#storage.db.prepare("SELECT 1 FROM scanned WHERE program=? AND signature=?").get(program, info.signature)) throw new Error("repeated indexer history");
        if (scannedCount++ >= this.maximumPending * 3) throw new Error("indexer scan history capacity exhausted");
        this.#storage.db.prepare("INSERT INTO scanned VALUES (?,?)").run(program, info.signature);
        scan.counts.scanned++;
        // Keep pagination progress even for transactions newer than this cycle's fixed chain head.
        if (info.slot <= scan.upperSlot) {
          const prior = this.#storage.db.prepare("SELECT slot,failed FROM pending WHERE signature=?").get(info.signature);
          if (prior && (prior.slot !== info.slot || Boolean(prior.failed) !== (info.err !== null))) throw new Error("conflicting indexer transaction evidence");
          if (!prior) {
            if (pendingCount++ >= this.maximumPending) throw new Error("indexer pending history capacity exhausted");
            this.#storage.db.prepare("INSERT INTO pending VALUES (?,?,?)").run(info.signature, info.slot, info.err === null ? 0 : 1);
            scan.counts.pending++;
          }
          this.#storage.db.prepare("INSERT INTO members VALUES (?,?)").run(program, info.signature);
          scan.counts.members++;
          if (previous?.slot === info.slot && previous.slot <= scan.upperSlot) scan.counts.edges += Number(this.#storage.db.prepare("INSERT OR IGNORE INTO edges VALUES (?,?)").run(info.signature, previous.signature).changes);
        }
        previous = { signature: info.signature, slot: info.slot };
      }
      if (!reached && page.length < limit && position.until) throw new Error("saved indexer cursor missing from provider history");
      position.previous = previous; position.before = page.at(-1)?.signature ?? before;
      if (reached || page.length < limit) { position.done = true; scan.nextProgram++; }
      this.#put("scan", scan);
    });
  }
  oldest(): Pending[] {
    this.assertOwned(); const scan = this.scan();
    if (!scan || scan.nextProgram !== scan.programs.length) return [];
    const rows = this.#storage.db.prepare("SELECT signature,slot,failed FROM pending WHERE slot=(SELECT MIN(slot) FROM pending) ORDER BY signature LIMIT ?").all(this.maximumSlot + 1);
    if (rows.length > this.maximumSlot) throw new Error("indexer slot exceeds bounded ordering capacity");
    const records = new Map(rows.map(r => [String(r.signature), { signature: String(r.signature), slot: Number(r.slot), failed: Boolean(r.failed),
      programs: this.#storage.db.prepare("SELECT program FROM members WHERE signature=?").all(r.signature!).map(m => String(m.program)) }]));
    const incoming = new Map([...records.keys()].map(s => [s, 0])), edges = new Map<string, string[]>();
    for (const signature of records.keys()) {
      const next = this.#storage.db.prepare("SELECT newer FROM edges WHERE older=?").all(signature).map(r => String(r.newer));
      edges.set(signature, next);
      for (const s of next) { if (!records.has(s)) throw new Error("invalid indexer ordering edge"); incoming.set(s, incoming.get(s)! + 1); }
    }
    const ready = [...records.keys()].filter(s => incoming.get(s) === 0), sorted: Pending[] = [];
    while (ready.length) { const s = ready.pop()!; sorted.push(records.get(s)!); for (const next of edges.get(s)!) { incoming.set(next, incoming.get(next)! - 1); if (!incoming.get(next)) ready.push(next); } }
    if (sorted.length !== records.size) throw new Error("inconsistent indexer transaction order"); return sorted;
  }
  complete(signature: string, snapshot: Snapshot): void {
    this.#storage.transaction(() => {
      this.assertOwned(); const scan = this.scan();
      if (!scan || !this.#storage.db.prepare("SELECT 1 FROM pending WHERE signature=?").get(signature)) throw new Error("indexer operation no longer pending");
      this.#put("snapshot", snapshot);
      scan.counts.edges -= Number(this.#storage.db.prepare("DELETE FROM edges WHERE older=? OR newer=?").run(signature, signature).changes);
      scan.counts.members -= Number(this.#storage.db.prepare("DELETE FROM members WHERE signature=?").run(signature).changes);
      this.#storage.db.prepare("DELETE FROM pending WHERE signature=?").run(signature);
      scan.counts.pending--; this.#put("scan", scan);
    });
  }
  finish(): boolean {
    return this.#storage.transaction(() => {
      this.assertOwned(); const scan = this.scan(); if (!scan || scan.nextProgram < scan.programs.length || this.pending()) return false;
      this.#storage.db.prepare("DELETE FROM scanned").run(); this.#put("through", scan.upperSlot); this.#put("scan", null); return true;
    });
  }
}
