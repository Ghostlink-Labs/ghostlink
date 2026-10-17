/** Bounded durable pagination followed by chronological transaction application. */
import { randomBytes } from "node:crypto";
import type { Connection, PublicKey } from "@solana/web3.js";
import { CENSUS, POCKET, REGISTRY, decodeLogs, decodeEventData } from "@ghostlink/service-kit";
import { IndexerDatabase } from "./database.js";
import type { IndexerStore } from "./store.js";

export interface PollerStatus {
  lastTickAt: string | null; lastSuccessAt: string | null; lastError: string | null;
  lastHeadAdvancedAt: string | null;
  appliedTotal: number; inFlight: boolean; catchingUp: boolean; pendingTransactions: number; appliedThroughSlot: number;
}
export interface PollerOptions { database?: IndexerDatabase; maximumPages?: number; maximumTransactions?: number; maximumTickMs?: number; paceMs?: number }
export class Poller {
  private head = -1;
  readonly status: PollerStatus = { lastHeadAdvancedAt: null, lastTickAt: null, lastSuccessAt: null, lastError: null, appliedTotal: 0, inFlight: false,
    catchingUp: true, pendingTransactions: 0, appliedThroughSlot: 0 };
  readonly database: IndexerDatabase;
  private draining = false;
  private readonly maximumPages: number;
  private readonly maximumTransactions: number;
  private readonly maximumTickMs: number;
  private readonly paceMs: number;
  constructor(private readonly connection: Connection, private readonly store: IndexerStore,
    private readonly programs: PublicKey[] = [REGISTRY, CENSUS, POCKET], private readonly pageSize = 1000,
    private readonly commitment: "confirmed" | "finalized" = "confirmed", options: PollerOptions = {}) {
    this.maximumPages = options.maximumPages ?? 4; this.maximumTransactions = options.maximumTransactions ?? 32;
    this.maximumTickMs = options.maximumTickMs ?? 10_000; this.paceMs = options.paceMs ?? 120;
    for (const n of [pageSize, this.maximumPages, this.maximumTransactions, this.maximumTickMs]) if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid indexer work limits");
    if (this.maximumPages > 100 || this.maximumTransactions > 1000 || this.maximumTickMs > 30_000 || this.paceMs > 1000 || pageSize > 1000 || !programs.length || new Set(programs.map(p => p.toBase58())).size !== programs.length || !Number.isSafeInteger(this.paceMs) || this.paceMs < 0) throw new Error("invalid indexer scan configuration");
    // In-process fixtures remain ephemeral; the hosted entry always supplies scoped persistent storage.
    this.database = options.database ?? new IndexerDatabase(":memory:", randomBytes(32), JSON.stringify(["ephemeral", programs.map(p => p.toBase58()), commitment]));
    if (!options.database) this.database.save(store.snapshot()); // Explicit ephemeral fixture only.
    store.restore(this.database.snapshot());
  }
  drain(): void { this.draining = true; }
  get idle(): boolean { return !this.status.inFlight; }
  async tick(): Promise<number> {
    if (this.status.inFlight || this.draining) return 0;
    this.status.inFlight = true; this.status.lastTickAt = new Date().toISOString();
    const deadline = Date.now() + this.maximumTickMs;
    const available = () => !this.draining && Date.now() < deadline;
    let applied = 0;
    try {
      this.database.renew();
      if (!this.database.scan()) {
        const head = await this.connection.getSlot(this.commitment);
        if (!available()) return 0;
        if (head > this.head) { this.head = head; this.status.lastHeadAdvancedAt = new Date().toISOString(); }
        this.database.begin(head, this.programs.map(p => p.toBase58()), this.store.cursors);
      }
      let pages = 0;
      while (pages < this.maximumPages && available()) {
        const scan = this.database.scan()!;
        if (scan.nextProgram === scan.programs.length) break;
        const program = this.programs[scan.nextProgram]!;
        const position = scan.positions[program.toBase58()]!;
        await this.pace(); if (!available()) break;
        // Deliberately include the saved cursor in the result so continuity can be checked.
        const page = await this.connection.getSignaturesForAddress(program,
          { limit: this.pageSize, before: position.before, minContextSlot: scan.upperSlot }, this.commitment);
        this.database.page(program.toBase58(), position.before, page, this.pageSize); pages++;
      }
      let processed = 0;
      while (processed < this.maximumTransactions && available()) {
        const group = this.database.oldest(); if (!group.length) break;
        for (const info of group) {
          if (processed >= this.maximumTransactions || !available()) break;
          let events: ReturnType<typeof decodeLogs> = [];
          if (!info.failed) {
            await this.pace(); if (!available()) break;
            const tx = await this.connection.getTransaction(info.signature, { maxSupportedTransactionVersion: 0, commitment: this.commitment });
            if (!tx?.meta) throw new Error("transaction metadata unavailable");
            if (tx.slot !== info.slot || tx.transaction.signatures[0] !== info.signature) throw new Error("transaction identity or slot mismatch");
            if (tx.meta.err === undefined) throw new Error("transaction execution status unavailable");
            if (tx.meta.err !== null) throw new Error("transaction execution status contradicts the signature page");
            if (tx.meta.err === null) {
              if (!Array.isArray(tx.meta.logMessages) || tx.meta.logMessages.some(line => typeof line !== "string" || /log truncated/i.test(line))) throw new Error("transaction logs unavailable or truncated");
              if (tx.meta.logMessages.length > 2048 || tx.meta.logMessages.reduce((n, line) => n + Buffer.byteLength(line), 0) > 64 * 1024) throw new Error("transaction logs exceed the ingestion work envelope");
              completeLogs(tx.meta.logMessages);
              events = decodeLogs(tx.meta.logMessages);
              if (events.length > 256) throw new Error("transaction events exceed the ingestion work envelope");
            }
          }
          // Checkpoint and dequeue are one FULL SQLite transaction; a crash cannot leave one ahead of the other.
          applied += this.store.checkpointTransaction(info.signature, events, info.programs, snapshot => this.database.complete(info.signature, snapshot));
          processed++;
        }
      }
      const complete = this.database.finish();
      this.status.pendingTransactions = this.database.pending(); this.status.catchingUp = !complete;
      this.status.appliedThroughSlot = this.database.through();
      if (complete) this.status.lastSuccessAt = new Date().toISOString();
      this.status.lastError = null;
      return applied;
    } catch (error) { this.status.lastError = "ingestion failed; preserving the durable checkpoint"; this.status.catchingUp = true; throw error; }
    finally { this.status.appliedTotal += applied; this.status.inFlight = false; }
  }
  private async pace(): Promise<void> { if (this.paceMs) await new Promise(resolve => setTimeout(resolve, this.paceMs)); }
  start(intervalMs = 15_000): NodeJS.Timeout {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 30_000) throw new Error("invalid polling interval");
    return setInterval(() => { void this.tick().catch(() => console.error("indexer poll failed; retaining durable progress")); }, intervalMs);
  }
}

/** Truncated/inconsistent invocation framing must never be treated as an empty successful event list. */
function completeLogs(logs: string[]): void {
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== stack.length + 1) throw new Error("transaction logs have inconsistent invocation depth");
      stack.push(invoke[1]!); continue;
    }
    if (stack.length === 1 && [REGISTRY, CENSUS, POCKET].some(program => program.toBase58() === stack[0]) && line.startsWith("Program data: ")) {
      const encoded = line.slice("Program data: ".length), payload = Buffer.from(encoded, "base64");
      if (payload.toString("base64") !== encoded || !decodeEventData(payload)) throw new Error("transaction logs contain an unknown or malformed protocol event");
    }
    const end = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:.*)$/.exec(line);
    if (end) { if (stack.pop() !== end[1]) throw new Error("transaction logs have inconsistent invocation boundaries"); }
  }
  if (stack.length) throw new Error("transaction logs end before invocation completion");
}
