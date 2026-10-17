import { performance } from "node:perf_hooks";
import { PublicKey, type Connection } from "@solana/web3.js";
import { HttpError, Router } from "@ghostlink/service-kit";
import type { createRpcPool } from "@ghostlink/service-kit/rpc";

export interface OperationsOptions {
  connection: Pick<Connection, "getGenesisHash" | "getSlot">;
  genesisHash: string;
  maxInFlight?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  freshnessMs?: number;
  progressTimeoutMs?: number;
  clock?: () => number;
}

/** This candidate has no verified public deployment; a cluster label cannot approve one. */
export function validateGenesis(genesis: string): void {
  if (typeof genesis !== "string" || new PublicKey(genesis).toBase58() !== genesis) throw new Error("approved Actions genesis required");
  if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(genesis)) {
    throw new Error("V2 Actions has no verified public deployment");
  }
}
const increment = (n: number) => Math.min(Number.MAX_SAFE_INTEGER, n + 1);
export class ActionsOperations {
  #clock: () => number;
  #interval: number; #timeout: number; #freshness: number; #progress: number; #maximum: number;
  #timer?: ReturnType<typeof setInterval>;
  #pending?: Promise<void>; #probing = false; #draining = false; #stopped = false;
  #rpc = false; #advanced = false; #sampleAt = -Infinity; #progressAt = -Infinity;
  #slot?: number; #floor = 0; #active = 0; #accepted = 0; #rejected = 0; #completed = 0;
  constructor(private readonly options: OperationsOptions) {
    validateGenesis(options.genesisHash);
    this.#clock = options.clock ?? (() => performance.now());
    this.#interval = options.probeIntervalMs ?? 2000; this.#timeout = options.probeTimeoutMs ?? 7000;
    this.#freshness = options.freshnessMs ?? 10_000; this.#progress = options.progressTimeoutMs ?? 15_000;
    this.#maximum = options.maxInFlight ?? 8;
    for (const n of [this.#interval, this.#timeout, this.#freshness, this.#progress, this.#maximum]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid Actions operations limit");
    }
    if (this.#maximum > 64) throw new Error("Actions concurrency exceeds 64");
  }
  get minimumSlot(): number { return this.#floor; }
  get idle(): boolean { return this.#active === 0 && !this.#probing; }
  observe(slot: number): void {
    if (!Number.isSafeInteger(slot) || slot < this.#floor) throw new HttpError(503, "fresh funding evidence unavailable");
    this.#floor = slot;
  }
  start(): void {
    if (this.#timer || this.#draining || this.#stopped) return;
    void this.refresh(); this.#timer = setInterval(() => { void this.refresh(); }, this.#interval); this.#timer.unref();
  }
  drain(): void { this.#draining = true; clearInterval(this.#timer); }
  stop(): void { this.drain(); this.#stopped = true; }
  refresh(): Promise<void> {
    if (this.#draining || this.#stopped || this.#probing) return this.#pending ?? Promise.resolve();
    this.#probing = true; this.#pending = this.#probe(); return this.#pending;
  }
  async #probe(): Promise<void> {
    const work = Promise.resolve().then(() => Promise.allSettled([this.options.connection.getGenesisHash(),
      this.options.connection.getSlot({ commitment: "confirmed", minContextSlot: this.#floor })]));
    void work.then(() => { this.#probing = false; }, () => { this.#probing = false; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [genesis, head] = await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), this.#timeout);
      })]);
      if (this.#stopped) return;
      if (genesis.status !== "fulfilled" || genesis.value !== this.options.genesisHash || head.status !== "fulfilled") throw new Error("chain unavailable");
      this.observe(head.value);
      const now = this.#clock();
      if (this.#slot !== undefined && head.value > this.#slot) { this.#advanced = true; this.#progressAt = now; }
      this.#slot = head.value; this.#sampleAt = now; this.#rpc = true;
    } catch { this.#rpc = false; }
    finally { clearTimeout(timer); }
  }
  #checks() {
    const now = this.#clock();
    return { rpc: this.#rpc, fresh: now >= this.#sampleAt && now - this.#sampleAt <= this.#freshness,
      chainProgress: this.#advanced && now >= this.#progressAt && now - this.#progressAt <= this.#progress };
  }
  assertFresh(): void {
    if (this.#stopped || !Object.values(this.#checks()).every(Boolean)) throw new HttpError(503, "funding service not ready");
  }
  async verifyChain(): Promise<void> {
    try { if (await this.options.connection.getGenesisHash() !== this.options.genesisHash) throw new Error(); }
    catch { this.#rpc = false; throw new HttpError(503, "funding chain unavailable"); }
  }
  snapshot() {
    const checks = { ...this.#checks(), accepting: !this.#draining && !this.#stopped, capacity: this.#active < this.#maximum };
    return { ready: Object.values(checks).every(Boolean), checks, active: this.#active, maximum: this.#maximum,
      probing: this.#probing, accepted: this.#accepted, rejected: this.#rejected, completed: this.#completed };
  }
  acquire(): (() => void) | undefined {
    if (!this.snapshot().ready) { this.#rejected = increment(this.#rejected); return; }
    this.#active++; this.#accepted = increment(this.#accepted);
    let released = false;
    return () => { if (!released) { released = true; this.#active--; this.#completed = increment(this.#completed); } };
  }
}

/** Caller binds this listener to loopback; only fixed labels and provider indices. */
export function operatorServer(operations: ActionsOperations, rpcStatus?: ReturnType<typeof createRpcPool>["status"]) {
  const router = new Router({ maxInFlight: 8, maxConnections: 32 });
  router.get("/metrics", async () => {
    const state = operations.snapshot();
    const lines = [`ghostlink_actions_ready ${Number(state.ready)}`, `ghostlink_actions_active ${state.active}`,
      `ghostlink_actions_capacity ${state.maximum}`, `ghostlink_actions_probe_in_flight ${Number(state.probing)}`];
    for (const [name, ok] of Object.entries(state.checks)) lines.push(`ghostlink_actions_check{check="${name}"} ${Number(ok)}`);
    for (const name of ["accepted", "rejected", "completed"] as const) lines.push(`ghostlink_actions_requests_total{outcome="${name}"} ${state[name]}`);
    if (rpcStatus) for (const endpoint of rpcStatus().endpoints) {
      lines.push(`ghostlink_rpc_available{provider="${endpoint.index}"} ${Number(endpoint.state === "available")}`,
        `ghostlink_rpc_quarantined{provider="${endpoint.index}"} ${Number(endpoint.state === "quarantined")}`);
    }
    return { text: lines.join("\n") + "\n", headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } };
  });
  return router.server();
}
