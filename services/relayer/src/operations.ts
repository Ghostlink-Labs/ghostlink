import { performance } from "node:perf_hooks";
import type { Connection, PublicKey } from "@solana/web3.js";
import { Router, HttpError } from "@ghostlink/service-kit";
import type { createRpcPool } from "@ghostlink/service-kit/rpc";

type Chain = Pick<Connection, "getGenesisHash" | "getBalanceAndContext">;
type Kind = "new" | "reconcile";
export interface OperationsOptions {
  connection: Chain;
  payer: PublicKey;
  genesisHash: string;
  journal: import("./journal.js").RelayerJournal;
  reconcile: (ids: string[]) => Promise<void>;
  minimumBalanceLamports: number;
  maxInFlight?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  freshnessMs?: number;
  progressTimeoutMs?: number;
  /** Monotonic elapsed time, injectable for deterministic failure drills. */
  clock?: () => number;
}
const count = (n: number) => Math.min(Number.MAX_SAFE_INTEGER, n + 1);

/** Cached admission evidence. Probes never start in response to an HTTP poll. */
export class RelayerOperations {
  #options: OperationsOptions;
  #clock: () => number;
  #intervalMs: number;
  #timeoutMs: number;
  #freshnessMs: number;
  #progressMs: number;
  #maximum: number;
  #timer?: ReturnType<typeof setInterval>;
  #probing = false;
  #pending?: Promise<void>;
  #stopped = false;
  #draining = false;
  #rpc = false;
  #storage = false;
  #balance = false;
  #budget = false;
  #recordCapacity = false;
  #lastReconciled?: string;
  #spent: string | null = null;
  #unsettled: string | null = null;
  #records = 0;
  #activeNew = 0;
  #sampleAt = -Infinity;
  #progressAt = -Infinity;
  #slot?: number;
  #advanced = false;
  #active = 0;
  #accepted = { new: 0, reconcile: 0 };
  #rejected = { new: 0, reconcile: 0 };
  #completed = { new: 0, reconcile: 0 };
  constructor(options: OperationsOptions) {
    this.#options = { ...options }; this.#clock = options.clock ?? (() => performance.now());
    this.#intervalMs = options.probeIntervalMs ?? 2000;
    this.#timeoutMs = options.probeTimeoutMs ?? 7000;
    this.#freshnessMs = options.freshnessMs ?? 10_000;
    this.#progressMs = options.progressTimeoutMs ?? 15_000;
    this.#maximum = options.maxInFlight ?? 8;
    if (!Number.isSafeInteger(this.#maximum) || this.#maximum < 2 || this.#maximum > 64) throw new Error("Relayer concurrency must be 2..64");
    for (const n of [this.#intervalMs, this.#timeoutMs, this.#freshnessMs, this.#progressMs, this.#maximum, options.minimumBalanceLamports]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid relayer operations limit");
    }
  }
  start(): void {
    if (this.#timer || this.#stopped) return;
    void this.refresh();
    this.#timer = setInterval(() => { void this.refresh(); }, this.#intervalMs);
    this.#timer.unref();
  }
  drain(): void { this.#draining = true; clearInterval(this.#timer); }
  get idle(): boolean { return this.#active === 0 && !this.#probing; }
  get minimumSlot(): number { return this.#slot ?? 0; }
  assertPreparationReady(): void {
    const { accepting: _, ...checks } = this.#checks();
    if (this.#stopped || !Object.values(checks).every(Boolean)) throw new HttpError(503, "relayer not ready; retain the original request");
  }
  stop(): void { this.drain(); this.#stopped = true; clearInterval(this.#timer); }

  refresh(): Promise<void> {
    if (this.#stopped || this.#draining || this.#probing) return this.#pending ?? Promise.resolve();
    this.#probing = true;
    this.#pending = this.#probe();
    return this.#pending;
  }
  async #probe(): Promise<void> {
    let reconcileIds: string[] = [];
    try {
      this.#options.journal.checkWritable();
      const ids = this.#options.journal.inspect(this.#slot ?? 0).reconcileIds;
      const next = ids.findIndex(id => !this.#lastReconciled || id > this.#lastReconciled);
      reconcileIds = ids.slice(next < 0 ? 0 : next, (next < 0 ? 0 : next) + 4);
      this.#lastReconciled = reconcileIds.at(-1); this.#storage = true;
    } catch { this.#storage = false; }
    const work = Promise.resolve().then(async () => {
      const [genesis, balance] = await Promise.allSettled([
        this.#options.connection.getGenesisHash(),
        this.#options.connection.getBalanceAndContext(this.#options.payer, { commitment: "confirmed", minContextSlot: this.#slot ?? 0 }),
        this.#options.reconcile(reconcileIds),
      ]);
      if (genesis.status !== "fulfilled" || balance.status !== "fulfilled") throw new Error("readiness RPC unavailable");
      return { genesis: genesis.value, balance: balance.value };
    });
    // A hung injected transport must not spawn an unbounded probe queue. Late
    // results after timeout are discarded; only settlement frees the probe slot.
    void work.then(() => { this.#probing = false; }, () => { this.#probing = false; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { genesis, balance } = await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), this.#timeoutMs);
      })]);
      if (this.#stopped) return;
      const slot = balance.context.slot, lamports = balance.value;
      if (genesis !== this.#options.genesisHash || !Number.isSafeInteger(slot) || slot < (this.#slot ?? 0) ||
        !Number.isSafeInteger(lamports) || lamports < 0) throw new Error("invalid readiness evidence");
      const now = this.#clock();
      if (this.#slot !== undefined && slot > this.#slot) { this.#advanced = true; this.#progressAt = now; }
      this.#slot = slot; this.#rpc = true; this.#sampleAt = now;
      try {
        const budget = this.#options.journal.inspect(slot);
        this.#spent = budget.spent.toString(); this.#unsettled = budget.unsettled.toString(); this.#records = budget.records;
        this.#budget = budget.spent < this.#options.journal.dailyBudget; this.#recordCapacity = budget.records < budget.maximumRecords;
        this.#balance = BigInt(lamports) >= BigInt(this.#options.minimumBalanceLamports) + budget.unsettled;
      } catch { this.#storage = false; this.#balance = false; }
    } catch {
      if (!this.#stopped) { this.#rpc = false; this.#balance = false; this.#sampleAt = this.#clock(); }
    } finally { clearTimeout(timer); }
  }

  #checks() {
    const now = this.#clock();
    return { rpc: this.#rpc, storage: this.#storage, feeReserve: this.#balance, dailyBudget: this.#budget, journalCapacity: this.#recordCapacity,
      fresh: now >= this.#sampleAt && now - this.#sampleAt <= this.#freshnessMs,
      chainProgress: this.#advanced && now >= this.#progressAt && now - this.#progressAt <= this.#progressMs,
      accepting: !this.#draining && !this.#stopped };
  }
  snapshot() {
    const checks = { ...this.#checks(), capacity: this.#active < this.#maximum && this.#activeNew < this.#maximum - 1 };
    return { ready: Object.values(checks).every(Boolean), checks, active: this.#active, maximum: this.#maximum,
      spentLamports24h: this.#spent, unsettledLamports: this.#unsettled, retainedRecords: this.#records,
      probing: this.#probing, accepted: { ...this.#accepted }, rejected: { ...this.#rejected }, completed: { ...this.#completed } };
  }

  /** Status reads remain available during dependency failure/drain if capacity remains. */
  acquire(kind: Kind): (() => void) | undefined {
    if (this.#stopped || this.#active >= this.#maximum || (kind === "new" && !this.snapshot().ready)) {
      this.#rejected[kind] = count(this.#rejected[kind]); return;
    }
    this.#active++; if (kind === "new") this.#activeNew++; this.#accepted[kind] = count(this.#accepted[kind]);
    let released = false;
    return () => {
      if (released) return;
      released = true; this.#active--; if (kind === "new") this.#activeNew--; this.#completed[kind] = count(this.#completed[kind]);
    };
  }
}

/** Bind this server to loopback in the entry point. No administrative HTTP writes. */
export function operatorServer(operations: RelayerOperations, rpcStatus?: ReturnType<typeof createRpcPool>["status"]) {
  const router = new Router({ exposeErrors: false, maxInFlight: 8, maxConnections: 32 });
  router.get("/metrics", async () => {
    const state = operations.snapshot();
    const lines = [`ghostlink_relayer_ready ${Number(state.ready)}`, `ghostlink_relayer_active ${state.active}`,
      `ghostlink_relayer_capacity ${state.maximum}`, `ghostlink_relayer_probe_in_flight ${Number(state.probing)}`,
      `ghostlink_relayer_retained_records ${state.retainedRecords}`];
    if (state.spentLamports24h !== null) lines.push(`ghostlink_relayer_reserved_lamports_24h ${state.spentLamports24h}`);
    if (state.unsettledLamports !== null) lines.push(`ghostlink_relayer_unsettled_lamports ${state.unsettledLamports}`);
    for (const [name, ok] of Object.entries(state.checks)) lines.push(`ghostlink_relayer_check{check="${name}"} ${Number(ok)}`);
    for (const kind of ["new", "reconcile"] as const) {
      for (const outcome of ["accepted", "rejected", "completed"] as const) {
        lines.push(`ghostlink_relayer_requests_total{kind="${kind}",outcome="${outcome}"} ${state[outcome][kind]}`);
      }
    }
    if (rpcStatus) {
      const rpc = rpcStatus();
      lines.push(`ghostlink_rpc_active ${rpc.active}`, `ghostlink_rpc_closed ${Number(rpc.closed)}`);
      for (const endpoint of rpc.endpoints) {
        const label = `{provider="${endpoint.index}"}`;
        lines.push(`ghostlink_rpc_available${label} ${Number(endpoint.state === "available")}`,
          `ghostlink_rpc_quarantined${label} ${Number(endpoint.state === "quarantined")}`,
          `ghostlink_rpc_consecutive_failures${label} ${endpoint.failures}`);
      }
    }
    return { text: lines.join("\n") + "\n", headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } };
  });
  return router.server();
}
