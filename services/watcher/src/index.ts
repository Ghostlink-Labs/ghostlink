/**
 * The watcher / notifier / timelock crank (build plan section 7).
 *
 * In plain language: the one thing an attacker with a stolen secret must
 * do loudly is propose a home-address change, because it waits 24 hours.
 * This service watches for those proposals (and unusually large fills)
 * and tells the user, so "cancel it" is always an option in time. Given
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
 *   NOTIFY_WEBHOOK — optional URL that receives JSON notifications
 *   LARGE_FILL_USD_E6 — threshold for large-fill alerts (default $100)
 *   GHOSTLINK_WATCHER_KEYPAIR — optional fee payer; enables the crank
 *   WATCHER_STATE_PATH — atomic cursor/pending snapshot; set for durable recovery
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { POCKET, decodeLogs, executeChangeIx, type GhostLinkEvent } from "@ghostlink/service-kit";

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
  ) {}

  async notify(subject: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`notify webhook: HTTP ${res.status}`);
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
    for (const [pocket, slot] of entries) {
      new PublicKey(pocket);
      if (!/^(0|[1-9][0-9]{0,19})$/.test(slot) || BigInt(slot) > 0xffffffffffffffffn) {
        throw new Error("invalid pending change slot in watcher snapshot");
      }
      this.after.set(pocket, BigInt(slot));
    }
  }
}

export class Watcher {
  /** Newest signature every notification of which was delivered. */
  private cursor: string | undefined;
  private busy = false;
  readonly pending = new PendingChanges();

  constructor(
    private readonly connection: Connection,
    private readonly notifier: Notifier,
    private readonly largeFillUsdE6: bigint,
    /** When set, due changes are executed with this payer. */
    private readonly cranker?: Keypair,
    private readonly statePath?: string,
  ) {
    if (statePath && existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.version !== 1 || (state.cursor !== undefined && typeof state.cursor !== "string") || !Array.isArray(state.pending)) {
        throw new Error("invalid watcher snapshot");
      }
      this.cursor = state.cursor;
      this.pending.restore(state.pending);
    }
  }

  private persist(): void {
    if (!this.statePath) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, cursor: this.cursor, pending: this.pending.snapshot() }));
    renameSync(tmp, this.statePath);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const sigs = [];
      let before: string | undefined;
      for (;;) {
        const page = await this.connection.getSignaturesForAddress(POCKET as PublicKey, {
          limit: 1000, before, until: this.cursor,
        }, "confirmed");
        sigs.push(...page);
        if (page.length < 1000) break;
        before = page[page.length - 1]!.signature;
      }
      for (const info of [...sigs].reverse()) {
        if (!info.err) {
          const tx = await this.connection.getTransaction(info.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          });
          if (!tx) throw new Error(`transaction ${info.signature} not available yet`);
          if (!tx.meta) throw new Error(`transaction ${info.signature} metadata not available yet`);
          const events = tx.meta.err ? [] : decodeLogs(tx.meta.logMessages ?? []);
          this.pending.observe(events);
          for (const n of eventsToNotifications(events, this.largeFillUsdE6)) {
            await withRetry(() => this.notifier.notify(n.subject, { ...n.body, signature: info.signature }));
          }
        }
        this.cursor = info.signature;
        this.persist();
      }
      if (this.cranker && this.pending.size > 0) await this.crank(this.cranker);
    } finally {
      this.busy = false;
    }
  }

  private async crank(payer: Keypair): Promise<void> {
    const slot = BigInt(await this.connection.getSlot("confirmed"));
    for (const pocket of this.pending.due(slot)) {
      try {
        const tx = new Transaction().add(executeChangeIx(payer.publicKey, new PublicKey(pocket)));
        tx.feePayer = payer.publicKey;
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.sign(payer);
        const signature = await this.connection.sendRawTransaction(tx.serialize());
        const status = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
        if (status.value.err) throw new Error(`crank failed on-chain: ${JSON.stringify(status.value.err)}`);
        this.pending.forget(pocket);
        this.persist();
        // Notify from the confirmed ChangeExecuted event on the next tick.
        // Its cursor is durable, so a delivery outage cannot lose this alert.
      } catch (e) {
        // Already executed or cancelled by someone else: the next
        // ChangeExecuted/ChangeCanceled event clears it; anything else is
        // retried next tick.
        console.error(`crank ${pocket}:`, (e as Error).message?.slice(0, 160) ?? e);
      }
    }
  }

  start(intervalMs = 5000): NodeJS.Timeout {
    return setInterval(() => {
      this.tick().catch((e) => console.error("watch error:", (e as Error).message ?? e));
    }, intervalMs);
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last;
}

// Entry point when run directly.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").replace(/^.*\//, ""));
if (isMain) {
  const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
  const notifier = process.env.NOTIFY_WEBHOOK
    ? new WebhookNotifier(process.env.NOTIFY_WEBHOOK)
    : new ConsoleNotifier();
  const threshold = BigInt(process.env.LARGE_FILL_USD_E6 ?? "100000000");
  const cranker = process.env.GHOSTLINK_WATCHER_KEYPAIR
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.GHOSTLINK_WATCHER_KEYPAIR, "utf8"))))
    : undefined;
  new Watcher(connection, notifier, threshold, cranker, process.env.WATCHER_STATE_PATH).start();
  console.log(`ghostlink watcher running${cranker ? ` (crank payer ${cranker.publicKey.toBase58()})` : ""}`);
}
