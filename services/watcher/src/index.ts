/**
 * The watcher / notifier / timelock crank (build plan section 7).
 *
 * In plain language: the one thing an attacker with a stolen secret must
 * do loudly is propose a home-address change, because it waits 24 hours.
 * This service watches for those proposals (and unusually large fills)
 * and forwards them to a configured receiver. Timely owner delivery still
 * depends on that receiver and service availability. Given
 * a keypair, it also cranks `execute_change` once a proposal's timelock
 * has elapsed, so a user who holds no SOL can still have their own
 * change applied (the instruction is permissionless; authorization
 * happened at propose time).
 *
 * A transaction counts as handled only once every notification for it
 * was delivered; a webhook outage means retrying, never forgetting.
 *
 * Environment:
 *   RPC_URL (default http://127.0.0.1:8899)
 *   RPC_ENDPOINTS_PATH — private approved endpoint file; overrides RPC_URL
 *   WATCHER_GENESIS_HASH — independently approved chain identity (required by entry point)
 *   NOTIFY_WEBHOOK — optional URL that receives JSON notifications
 *   LARGE_FILL_USD_E6 — threshold for large-fill alerts (default $100)
 *   GHOSTLINK_WATCHER_KEYPAIR — optional fee payer; enables the crank
 *   WATCHER_STATE_PATH / WATCHER_STATE_KEY_PATH — durable scoped queue and raw 32-byte encryption key (required)
 *   WATCHER_STATE_ID — independently pinned encrypted observation-state identity
 *   WATCHER_POLL_MS — polling interval, 100..30000 (default 5000)
 *   WATCHER_JOURNAL_PATH / WATCHER_JOURNAL_KEY_PATH — required for funded execution
 *   WATCHER_JOURNAL_ID — independently pinned encrypted crank-journal identity (funded mode)
 *   WATCHER_TOTAL_BUDGET_LAMPORTS — explicit cumulative fee cap, never reset by restart
 *   WATCHER_MAX_FEE_LAMPORTS — per-packet cap (default 20000)
 */
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { POCKET, type GhostLinkEvent } from "@ghostlink/service-kit";
import { createRpcPool, loadRpcEndpoints } from "@ghostlink/service-kit/rpc";
import { CrankJournal } from "./journal.js";
import { DurableCranker } from "./crank.js";
import { WatcherState } from "./state.js";
import { completeEvents } from "./logs.js";
export { CrankJournal, DurableCranker, WatcherState };

export interface Notifier {
  notify(subject: string, body: Record<string, unknown>): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  async notify(subject: string, body: Record<string, unknown>): Promise<void> {
    console.log(`[notify] ${subject}:`, JSON.stringify(body));
  }
}

export class WebhookNotifier implements Notifier {
  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    let endpoint: URL;
    try { endpoint = new URL(url); } catch { throw new Error("invalid notification endpoint"); }
    if (endpoint.username || endpoint.password || endpoint.hash || (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) {
      throw new Error("notification endpoint requires HTTPS or loopback HTTP without userinfo or fragments");
    }
  }

  async notify(subject: string, body: Record<string, unknown>): Promise<void> {
    try {
      const res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, subject }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      await res.body?.cancel(); // Only the status is used; never retain an unbounded streaming reply.
      if (!res.ok) throw new Error();
    } catch { throw new Error("notification delivery failed"); }
  }
}

export function eventsToNotifications(
  events: GhostLinkEvent[],
  largeFillUsdE6: bigint,
): { subject: string; body: Record<string, unknown> }[] {
  const out: { subject: string; body: Record<string, unknown> }[] = [];
  for (const event of events) {
    if (event.kind === "ChangeExecuted") {
      out.push({ subject: "Pocket change executed after its timelock", body: { pocket: event.pocket } });
    }
    if (event.kind === "ChangeProposed") {
      out.push({
        subject: "Pocket change proposed — executable after the 24h timelock",
        body: {
          pocket: event.pocket,
          executableAfterSlot: event.executableAfterSlot.toString(),
          hint: "If this was not you, cancel it or sweep home now.",
        },
      });
    }
    if (event.kind === "Filled" && event.inValueUsdE6 >= largeFillUsdE6) {
      out.push({
        subject: "Large fill on your pocket",
        body: {
          pocket: event.pocket,
          inMint: event.inMint,
          usdE6: event.inValueUsdE6.toString(),
          mode: event.mode,
          releasedCostUsdE6: event.releasedCostUsdE6.toString(),
        },
      });
    }
  }
  return out;
}

/** Proposals whose timelock the crank is waiting out, keyed by pocket. */
export class PendingChanges {
  private readonly after = new Map<string, bigint>();

  /** Tracks proposals; forgets on execution or cancellation. */
  observe(events: GhostLinkEvent[]): void {
    for (const event of events) {
      if (event.kind === "ChangeProposed") this.after.set(event.pocket, event.executableAfterSlot);
      if (event.kind === "ChangeExecuted" || event.kind === "ChangeCanceled") this.after.delete(event.pocket);
    }
  }

  /** Pockets whose change can be executed at `slot`. */
  due(slot: bigint): string[] {
    return [...this.after].filter(([, after]) => slot >= after).map(([pocket]) => pocket);
  }

  forget(pocket: string): void {
    this.after.delete(pocket);
  }

  get size(): number {
    return this.after.size;
  }

  snapshot(): [string, string][] {
    return [...this.after].map(([pocket, slot]) => [pocket, slot.toString()]);
  }

  restore(entries: [string, string][]): void {
    const restored = new Map<string, bigint>();
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") throw new Error("invalid pending change snapshot");
      const [pocket, slot] = entry;
      if (new PublicKey(pocket).toBase58() !== pocket || restored.has(pocket)) throw new Error("invalid pending change snapshot");
      if (!/^(0|[1-9][0-9]{0,19})$/.test(slot) || BigInt(slot) > 0xffffffffffffffffn) {
        throw new Error("invalid pending change slot in watcher snapshot");
      }
      restored.set(pocket, BigInt(slot));
    }
    this.after.clear();
    for (const [pocket, slot] of restored) this.after.set(pocket, slot);
  }
}

export interface WatcherOptions { maximumPages?: number; maximumTransactions?: number; maximumDeliveries?: number; maximumTickMs?: number; pageSize?: number }
export class Watcher {
  private busy = false;
  private stopping = false;
  private head = -1;
  private readonly durableCranker?: DurableCranker;
  readonly pending = new PendingChanges();
  readonly state: WatcherState;
  readonly status = { lastSuccessAt: null as string | null, lastHeadAdvancedAt: null as string | null,
    lastError: null as string | null, catchingUp: true, pendingTransactions: 0, appliedThroughSlot: 0 };
  private readonly limits: Required<WatcherOptions>;
  constructor(private readonly connection: Connection, private readonly notifier: Notifier, private readonly largeFillUsdE6: bigint,
    cranker?: Keypair, state?: WatcherState, private readonly journal?: CrankJournal, options: WatcherOptions = {}) {
    if (largeFillUsdE6 < 0n || largeFillUsdE6 > 0xffffffffffffffffn) throw new Error("invalid watcher alert threshold");
    this.limits = { maximumPages: 4, maximumTransactions: 32, maximumDeliveries: 32, maximumTickMs: 10_000, pageSize: 1000, ...options };
    for (const [name, maximum] of Object.entries({ maximumPages: 100, maximumTransactions: 1000, maximumDeliveries: 256, maximumTickMs: 30_000, pageSize: 1000 })) {
      const value = this.limits[name as keyof WatcherOptions];
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("invalid watcher work limits");
    }
    if (cranker && (!state || !journal || state.scope.genesisHash !== journal.scope.genesisHash || state.scope.payer !== cranker.publicKey.toBase58())) throw new Error("funded watcher requires scoped durable state and crank journal");
    if (journal && !cranker) throw new Error("crank journal requires its payer");
    // Only in-process observer fixtures may omit storage. Hosted startup always supplies a durable scoped database.
    this.state = state ?? new WatcherState(":memory:", randomBytes(32), { genesisHash: "11111111111111111111111111111111",
      pocketProgram: POCKET.toBase58(), payer: null, receiver: "fixture", threshold: largeFillUsdE6.toString() });
    if (this.state.scope.pocketProgram !== POCKET.toBase58() || this.state.scope.payer !== (cranker?.publicKey.toBase58() ?? null) ||
      this.state.scope.threshold !== largeFillUsdE6.toString()) throw new Error("watcher state configuration mismatch");
    this.pending.restore(this.state.snapshot().pending);
    if (cranker) this.durableCranker = new DurableCranker(connection, cranker, journal!);
  }
  get idle(): boolean { return !this.busy; }
  drain(): void { this.stopping = true; }
  close(): void { if (this.busy) throw new Error("watcher must drain before close"); this.stopping = true; this.state.close(); }
  ready(): boolean {
    try { this.state.assertOwned(); } catch { return false; }
    const fresh = (time: string | null) => time !== null && Date.now() - Date.parse(time) >= 0 && Date.now() - Date.parse(time) < 30_000;
    return !this.stopping && !this.status.catchingUp && this.status.lastError === null && fresh(this.status.lastSuccessAt) && fresh(this.status.lastHeadAdvancedAt);
  }
  async tick(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    const deadline = Date.now() + this.limits.maximumTickMs, available = () => !this.stopping && Date.now() < deadline;
    let delivered = 0, processed = 0;
    try {
      this.state.renew();
      if (!this.state.scan()) {
        const head = await this.connection.getSlot("confirmed");
        if (!available()) return;
        if (head > this.head) { this.head = head; this.status.lastHeadAdvancedAt = new Date().toISOString(); }
        this.state.begin(head);
      }
      for (let n = 0; n < this.limits.maximumPages && available(); n++) {
        const scan = this.state.scan()!; if (scan.done) break;
        const page = await this.connection.getSignaturesForAddress(POCKET, { limit: this.limits.pageSize, before: scan.before, minContextSlot: scan.upperSlot }, "confirmed");
        this.state.page(scan.before, page, this.limits.pageSize);
      }
      while (processed < this.limits.maximumTransactions && available()) {
        const observation = this.state.oldest(); if (!observation) break;
        let delivery = this.state.delivery();
        if (!delivery) {
          let events: GhostLinkEvent[] = [];
          if (!observation.failed) {
            const tx = await this.connection.getTransaction(observation.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
            if (!tx?.meta || tx.slot !== observation.slot || tx.transaction.signatures[0] !== observation.signature) throw new Error("watcher transaction identity or metadata unavailable");
            if (tx.meta.err !== null) throw new Error("watcher transaction status contradicts history");
            events = completeEvents(tx.meta.logMessages);
          }
          const candidate = new PendingChanges(); candidate.restore(this.state.snapshot().pending); candidate.observe(events);
          delivery = this.state.prepare(observation, candidate.snapshot(), eventsToNotifications(events, this.largeFillUsdE6));
        }
        while (delivery.next < delivery.alerts.length && delivered < this.limits.maximumDeliveries && available()) {
          const alert = delivery.alerts[delivery.next]!;
          this.state.renew();
          // One admitted attempt per alert per tick. Failures retry the exact durable body/ID on the next tick.
          await this.notifier.notify(alert.subject, structuredClone(alert.body));
          this.state.acknowledge(String(alert.body.eventId)); delivered++; delivery = this.state.delivery()!;
        }
        if (delivery.next < delivery.alerts.length) break;
        this.state.complete(observation.signature); this.pending.restore(this.state.snapshot().pending); processed++;
      }
      const complete = this.state.finish();
      this.status.catchingUp = !complete; this.status.pendingTransactions = this.state.count(); this.status.appliedThroughSlot = this.state.through();
      if (complete) {
        this.status.lastSuccessAt = new Date().toISOString();
        if (this.durableCranker && available()) await this.crank(available);
      }
      this.status.lastError = null;
    } catch (error) { this.status.catchingUp = true; this.status.lastError = "watcher progress failed; preserving durable work"; throw error; }
    finally { this.busy = false; }
  }
  private async crank(available: () => boolean): Promise<void> {
    this.state.renew(); this.pending.restore(this.state.snapshot().pending);
    const slot = BigInt(await this.connection.getSlot("confirmed"));
    const pockets = new Set([...this.journal!.outstanding(), ...this.pending.due(slot)]);
    let admitted = 0;
    for (const pocket of pockets) {
      if (!available() || admitted++ >= this.limits.maximumTransactions) break;
      this.state.renew();
      try { await this.durableCranker!.execute(pocket); }
      catch { console.error("watcher crank not confirmed; retaining pending change"); }
    }
  }
  start(intervalMs = 5000): NodeJS.Timeout {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 30_000) throw new Error("invalid watcher polling interval");
    return setInterval(() => { void this.tick().catch(() => console.error("watcher poll failed; preserving saved progress")); }, intervalMs);
  }
}

// Entry point when run directly.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
async function main() {
  const genesisHash = process.env.WATCHER_GENESIS_HASH, statePath = process.env.WATCHER_STATE_PATH, keyPath = process.env.WATCHER_STATE_KEY_PATH;
  const stateId = process.env.WATCHER_STATE_ID;
  if (!genesisHash || !statePath || !keyPath || !stateId || !/^[0-9a-f]{64}$/.test(stateId)) throw new Error("approved watcher chain, durable state, pinned identity and encryption key are required");
  const rpc = createRpcPool({ genesisHash, endpoints: loadRpcEndpoints(process.env.RPC_ENDPOINTS_PATH, process.env.RPC_URL) });
  let journal: CrankJournal | undefined, state: WatcherState | undefined;
  const server = createServer();
  try {
    await rpc.connection.getGenesisHash();
    const notifier = process.env.NOTIFY_WEBHOOK ? new WebhookNotifier(process.env.NOTIFY_WEBHOOK) : new ConsoleNotifier();
    const threshold = BigInt(process.env.LARGE_FILL_USD_E6 ?? "100000000");
    const cranker = process.env.GHOSTLINK_WATCHER_KEYPAIR
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.GHOSTLINK_WATCHER_KEYPAIR, "utf8")))) : undefined;
    if (cranker) {
      const journalPath = process.env.WATCHER_JOURNAL_PATH, journalKeyPath = process.env.WATCHER_JOURNAL_KEY_PATH, journalId = process.env.WATCHER_JOURNAL_ID;
      if (!journalPath || !journalKeyPath || !process.env.WATCHER_TOTAL_BUDGET_LAMPORTS || !journalId) throw new Error("funded watcher journal, pinned identity and budget are required");
      const journalKey = readFileSync(journalKeyPath);
      try { journal = CrankJournal.openExisting(journalPath, journalKey, { genesisHash, pocketProgram: POCKET.toBase58(), payer: cranker.publicKey.toBase58() }, {
        maximumFeeLamports: Number(process.env.WATCHER_MAX_FEE_LAMPORTS ?? 20_000), totalBudgetLamports: Number(process.env.WATCHER_TOTAL_BUDGET_LAMPORTS),
      }, journalId); } finally { journalKey.fill(0); }
    }
    const key = readFileSync(keyPath);
    try { state = WatcherState.openExisting(statePath, key, { genesisHash, pocketProgram: POCKET.toBase58(), payer: cranker?.publicKey.toBase58() ?? null,
      receiver: createHash("sha256").update(process.env.NOTIFY_WEBHOOK ?? "console").digest("hex"), threshold: threshold.toString() }, stateId); }
    finally { key.fill(0); }
    const watcher = new Watcher(rpc.connection, notifier, threshold, cranker, state, journal, {
      maximumPages: Number(process.env.WATCHER_PAGES_PER_TICK ?? 4), maximumTransactions: Number(process.env.WATCHER_TRANSACTIONS_PER_TICK ?? 32),
      maximumDeliveries: Number(process.env.WATCHER_DELIVERIES_PER_TICK ?? 32), maximumTickMs: Number(process.env.WATCHER_TICK_BUDGET_MS ?? 10_000),
    });
    const port = Number(process.env.WATCHER_PORT ?? process.env.PORT ?? 8791), interval = Number(process.env.WATCHER_POLL_MS ?? 5000);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(interval) || interval < 100 || interval > 30_000) throw new Error("invalid watcher service limits");
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 64;
    server.on("request", (req, res) => {
      const route = req.method === "GET" && (req.url === "/ready" || req.url === "/health");
      const ready = watcher.ready(); res.writeHead(route ? (req.url === "/ready" && !ready ? 503 : 200) : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(route ? { ready } : { error: "not found" }));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, resolve); });
    const timer = watcher.start(interval);
    let stopping = false;
    const shutdown = (failed = false) => {
      if (stopping) return;
      stopping = true; clearInterval(timer); clearInterval(lease); watcher.drain(); server.close();
      const deadline = setTimeout(() => { server.closeAllConnections(); rpc.close(); state?.close(); journal?.close(); process.exit(1); }, 30_000); deadline.unref();
      const drain = setInterval(() => {
        if (!watcher.idle) return;
        clearInterval(drain); clearTimeout(deadline); server.closeAllConnections(); rpc.close(); watcher.close(); journal?.close();
        if (failed) process.exitCode = 1;
      }, 50);
    };
    const lease = setInterval(() => { try { state!.renew(); } catch { shutdown(true); } }, 15_000);
    process.once("SIGTERM", () => shutdown()); process.once("SIGINT", () => shutdown());
    void watcher.tick().catch(() => console.error("watcher poll failed; preserving saved progress"));
    console.log(`ghostlink watcher running on :${port}`);
  } catch (error) { server.close(); rpc.close(); state?.close(); journal?.close(); throw error; }
}
if (isMain) void main().catch(() => { console.error("watcher startup failed; check approved configuration and dependencies"); process.exitCode = 1; });
