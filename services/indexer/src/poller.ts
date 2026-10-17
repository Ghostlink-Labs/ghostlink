/**
 * RPC polling ingestion for localnet/devnet without webhooks.
 *
 * Each tick gathers every signature newer than the per-program cursor
 * (paginating backwards with `before`, so a fresh deploy can backfill a
 * history of any length), orders them chronologically across all three
 * programs, and applies their logs one transaction at a time. A cursor
 * only advances past a transaction once it has been applied, so an RPC
 * hiccup (429, not-yet-available) stops the tick and the same signature
 * is retried next time — nothing is ever skipped. Cursors live in the
 * store's snapshot, so a restart resumes instead of replaying history.
 */
import type { ConfirmedSignatureInfo, Connection, PublicKey } from "@solana/web3.js";
import { CENSUS, POCKET, REGISTRY, decodeLogs } from "@ghostlink/service-kit";
import type { IndexerStore } from "./store.js";

export interface PollerStatus {
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  appliedTotal: number;
  inFlight: boolean;
}

interface Pending {
  info: ConfirmedSignatureInfo;
  programs: string[];
  /** Immediate newer transactions in each RPC listing, within the same slot. */
  newer: Set<string>;
}

export class Poller {
  readonly status: PollerStatus = {
    lastTickAt: null,
    lastSuccessAt: null,
    lastError: null,
    appliedTotal: 0,
    inFlight: false,
  };

  constructor(
    private readonly connection: Connection,
    private readonly store: IndexerStore,
    private readonly programs: PublicKey[] = [REGISTRY, CENSUS, POCKET],
    private readonly pageSize = 1000,
    /** `finalized` rules out ever ingesting a leaf from a skipped slot. */
    private readonly commitment: "confirmed" | "finalized" = "confirmed",
  ) {}

  async tick(): Promise<number> {
    if (this.status.inFlight) return 0;
    this.status.inFlight = true;
    this.status.lastTickAt = new Date().toISOString();
    try {
      const batch = await this.gather();
      let applied = 0;
      for (const { info, programs } of batch) {
        if (!info.err) {
          const tx = await politely(() =>
            this.connection.getTransaction(info.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: this.commitment,
            }),
          );
          if (!tx) throw new Error(`transaction ${info.signature} not available from RPC yet`);
          if (!tx.meta) throw new Error(`transaction ${info.signature} metadata not available from RPC yet`);
          if (!tx.meta.err) {
            applied += this.store.applyTransaction(info.signature, decodeLogs(tx.meta.logMessages ?? []));
          }
        }
        // Only now is this signature behind us.
        for (const program of programs) this.store.setCursor(program, info.signature);
      }
      this.status.appliedTotal += applied;
      this.status.lastSuccessAt = new Date().toISOString();
      this.status.lastError = null;
      return applied;
    } catch (e) {
      this.status.lastError = "ingestion failed; retrying from the saved cursor";
      throw e;
    } finally {
      this.status.inFlight = false;
    }
  }

  /** Every unprocessed signature across all programs, oldest first. */
  private async gather(): Promise<Pending[]> {
    const pending = new Map<string, Pending>();
    for (const program of this.programs) {
      const key = program.toBase58();
      const until = this.store.cursors.get(key);
      let before: string | undefined;
      let newer: ConfirmedSignatureInfo | undefined;
      for (;;) {
        const page = await politely(() =>
          this.connection.getSignaturesForAddress(
            program,
            { limit: this.pageSize, before, until },
            this.commitment,
          ),
        );
        for (const info of page) {
          const existing = pending.get(info.signature);
          if (existing) existing.programs.push(key);
          else pending.set(info.signature, { info, programs: [key], newer: new Set() });
          if (newer?.slot === info.slot) pending.get(info.signature)!.newer.add(newer.signature);
          newer = info;
        }
        if (page.length < this.pageSize) break;
        before = page[page.length - 1]!.signature;
      }
    }
    // A global scan index is not a transaction index: a shared transaction
    // may appear in several program lists. Merge their ordering constraints.
    const bySlot = new Map<number, Pending[]>();
    for (const item of pending.values()) {
      const items = bySlot.get(item.info.slot) ?? [];
      items.push(item);
      bySlot.set(item.info.slot, items);
    }
    const sorted: Pending[] = [];
    for (const [, items] of [...bySlot].sort(([a], [b]) => a - b)) {
      const incoming = new Map(items.map((item) => [item.info.signature, 0]));
      for (const item of items) for (const next of item.newer) incoming.set(next, incoming.get(next)! + 1);
      const ready = items.filter((item) => incoming.get(item.info.signature) === 0);
      let count = 0;
      while (ready.length) {
        const item = ready.pop()!;
        sorted.push(item);
        count += 1;
        for (const next of item.newer) {
          const left = incoming.get(next)! - 1;
          incoming.set(next, left);
          if (left === 0) ready.push(pending.get(next)!);
        }
      }
      if (count !== items.length) throw new Error("RPC returned inconsistent transaction order; retrying without advancing cursors");
    }
    return sorted;
  }

  start(intervalMs = 15_000): NodeJS.Timeout {
    return setInterval(() => {
      this.tick().catch(() => console.error("indexer poll failed; retrying from the saved cursor"));
    }, intervalMs);
  }
}

const PACE_MS = 120;
const RATE_LIMIT_ATTEMPTS = 6;

/**
 * Public RPC manners: a short pause before every call, and on a 429 an
 * exponential backoff (up to ~1 minute in total) before the SAME call is
 * retried. Anything else, or a limit that will not lift, propagates and
 * the tick stops where it is — the cursor never moves past it.
 */
async function politely<T>(call: () => Promise<T>): Promise<T> {
  let delay = 1_000;
  for (let attempt = 1; ; attempt++) {
    await new Promise((r) => setTimeout(r, PACE_MS));
    try {
      return await call();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (!/429|Too Many Requests/i.test(text) || attempt >= RATE_LIMIT_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 20_000);
    }
  }
}
