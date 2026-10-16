/** HTTP surface of the indexer (wire shapes in @ghostlink/common api.ts). */
import type { Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { HttpError, Router, decodeLogs, type GhostLinkEvent } from "@ghostlink/service-kit";
import type { IndexerStore } from "./store.js";
import type { PollerStatus } from "./poller.js";
import type { ChainRoots } from "./chain-roots.js";

export interface ServerOptions {
  /**
   * Shared secret a webhook poster must send in `authorization` (Helius:
   * the `authHeader` of the webhook). Without it POST /webhook is off.
   */
  webhookSecret?: string;
  /** When set, every tree event's root must be in the on-chain ring. */
  chainRoots?: ChainRoots;
  poller?: PollerStatus;
}

export function buildServer(store: IndexerStore, options: ServerOptions = {}): Server {
  // Webhook batches can be large; everything else is tiny.
  const router = new Router({ maxBodyBytes: 1024 * 1024 });

  router.get("/health", async () => ({
    json: {
      ok: !options.poller || options.poller.lastError === null,
      registryLeaves: store.registryLeaves.length,
      censusLeaves: store.censusLeaves.length,
      webhook: Boolean(options.webhookSecret),
      poller: options.poller ?? null,
    },
  }));

  router.get("/roots/:tree", async ({ params }) => {
    const tree = params.tree === "registry" ? "registry" : params.tree === "census" ? "census" : null;
    if (!tree) return { status: 404, json: { error: "unknown tree" } };
    const t = tree === "registry" ? store.registry : store.census;
    return {
      json: { tree, roots: store.recentRoots(tree), nextIndex: t.nextIndex },
    };
  });

  router.get("/path/:tree/:leafIndex", async ({ params }) => {
    const tree = params.tree === "registry" ? store.registry : params.tree === "census" ? store.census : null;
    if (!tree) return { status: 404, json: { error: "unknown tree" } };
    if (!/^(0|[1-9][0-9]{0,15})$/.test(params.leafIndex ?? "")) return { status: 400, json: { error: "bad leaf index" } };
    const index = Number(params.leafIndex);
    if (index >= tree.nextIndex) return { status: 404, json: { error: "no such leaf" } };
    const path = tree.path(index);
    return {
      json: {
        tree: params.tree,
        index: path.index,
        siblings: path.siblings.map((s) => s.toString()),
        root: tree.root.toString(),
      },
    };
  });

  /**
   * A page of leaves in append order, so a client can rebuild the tree
   * and compute its own path without ever naming the leaf it wants.
   */
  router.get("/leaves/:tree", async ({ params, query }) => {
    const leaves = params.tree === "registry" ? store.registryLeaves : params.tree === "census" ? store.censusLeaves : null;
    if (!leaves) return { status: 404, json: { error: "unknown tree" } };
    const from = pageInteger(query.get("from"), 0, 0, Number.MAX_SAFE_INTEGER, "from");
    const limit = pageInteger(query.get("limit"), 5000, 1, 5000, "limit");
    return {
      json: { tree: params.tree, from, leaves: leaves.slice(from, from + limit), nextIndex: leaves.length },
    };
  });

  router.get("/registry/binding/:wallet", async ({ params }) => {
    const binding = store.bindings.get(params.wallet ?? "");
    if (!binding) return { status: 404, json: { error: "not registered" } };
    return { json: { leafIndex: binding.leafIndex, commitment: binding.commitmentHex, slot: "0" } };
  });

  router.get("/census/latest", async ({ query }) => {
    const wallet = query.get("wallet");
    const mint = query.get("mint");
    if (!wallet || !mint) return { status: 400, json: { error: "wallet and mint required" } };
    const entry = store.latestCensus.get(`${wallet}:${mint}`);
    if (!entry) return { status: 404, json: { error: "no snapshot" } };
    return { json: entry };
  });

  // ---- dashboard API -----------------------------------------------------

  router.get("/pockets/:appIdHex", async ({ params }) => {
    const entry = store.pocketByAppId(params.appIdHex ?? "");
    if (!entry) return { status: 404, json: { error: "no pocket for this app id" } };
    return { json: entry };
  });

  router.get("/activity/:pocket", async ({ params, query }) => {
    const limit = pageInteger(query.get("limit"), 50, 1, 200, "limit");
    return { json: { pocket: params.pocket, events: store.activityFor(params.pocket!, limit) } };
  });

  router.get("/stats", async () => ({
    json: {
      registrations: store.registryLeaves.length,
      snapshots: store.censusLeaves.length,
      pockets: store.pockets.size,
      activity: store.activity.length,
    },
  }));

  /**
   * Webhook ingestion: a Helius raw-transaction webhook array (each item
   * carrying `meta.logMessages`) or the shape { logs: string[] }. Needs
   * the shared secret, drops failed transactions, and — when the chain
   * is reachable — accepts a tree event only if its root is in the
   * program's own root ring. The store's chaining checks run after that.
   */
  router.post("/webhook", async ({ body, raw }) => {
    if (!options.webhookSecret) throw new HttpError(404, "webhook disabled: set WEBHOOK_SECRET");
    if (!authorized(raw.headers.authorization, options.webhookSecret)) {
      throw new HttpError(401, "bad webhook secret");
    }
    const batches: { logs: string[]; signature?: string }[] = [];
    const add = (logs: unknown, signature: unknown) => {
      if (!Array.isArray(logs) || !logs.every((line) => typeof line === "string")) throw new HttpError(400, "logs must be an array of strings");
      if (signature !== undefined && (typeof signature !== "string" || !signature || signature.length > 128)) {
        throw new HttpError(400, "invalid transaction signature");
      }
      batches.push({ logs, signature: signature as string | undefined });
    };
    if (Array.isArray(body)) {
      for (const item of body as { signature?: string; transaction?: { signatures?: string[] }; meta?: { err?: unknown; logMessages?: string[] } }[]) {
        if (item?.meta?.err) continue;
        if (Array.isArray(item?.meta?.logMessages)) add(item.meta.logMessages, item.signature ?? item.transaction?.signatures?.[0]);
      }
    } else if (body && typeof body === "object" && Array.isArray((body as { logs?: unknown }).logs)) {
      const item = body as { logs: unknown; signature?: unknown };
      add(item.logs, item.signature);
    } else {
      throw new HttpError(400, "expected a transaction array or { logs }");
    }
    let applied = 0;
    let ignored = 0;
    for (const { logs, signature } of batches) {
      const events = decodeLogs(logs);
      if (!signature && events.some((event) => event.kind !== "Registered" && event.kind !== "SnapshotTaken")) {
        throw new HttpError(400, "transaction signature required for pocket events");
      }
      let valid = true;
      for (const event of events) {
        if (options.chainRoots && !(await rootOnChain(options.chainRoots, event))) {
          valid = false;
          break;
        }
      }
      if (!valid) { ignored += events.length; continue; }
      const count = signature ? store.applyTransaction(signature, events) : events.filter((event) => store.apply(event)).length;
      applied += count;
      ignored += events.length - count;
    }
    return { json: { applied, ignored } };
  });

  return router.server();
}

function pageInteger(value: string | null, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new HttpError(400, `bad ${name}`);
  }
  return Math.min(parsed, maximum);
}

async function rootOnChain(chain: ChainRoots, event: GhostLinkEvent): Promise<boolean> {
  if (event.kind === "Registered") return chain.contains("registry", event.root);
  if (event.kind === "SnapshotTaken") return chain.contains("census", event.root);
  return true;
}

function authorized(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
