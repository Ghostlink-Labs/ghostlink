/**
 * Entry point. Environment:
 *   PORT (default 8787)
 *   RPC_URL — enables polling ingestion and on-chain root checks when set
 *   RPC_ENDPOINTS_PATH — private provider configuration, overrides RPC_URL
 *   INDEXER_GENESIS_HASH — independently approved chain identity; required with RPC
 *   PERSIST_PATH — JSON snapshot location (optional but recommended)
 *   WEBHOOK_SECRET — enables POST /webhook; Helius sends it as the
 *                    webhook's authHeader
 *   POLL_MS — polling interval (default 15000)
 *   INGEST_COMMITMENT — confirmed (default) or finalized
 */
import { createRpcPool, loadRpcEndpoints } from "@ghostlink/service-kit/rpc";
import { buildServer } from "./server.js";
import { IndexerStore } from "./store.js";
import { Poller } from "./poller.js";
import { ChainRoots } from "./chain-roots.js";

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got ${process.env.PORT}`);
const store = IndexerStore.load(process.env.PERSIST_PATH);

let poller: Poller | undefined;
let chainRoots: ChainRoots | undefined;
if (process.env.RPC_URL || process.env.RPC_ENDPOINTS_PATH) {
  const genesisHash = process.env.INDEXER_GENESIS_HASH;
  if (!genesisHash) throw new Error("INDEXER_GENESIS_HASH is required for RPC ingestion");
  const rpc = createRpcPool({ genesisHash, endpoints: loadRpcEndpoints(process.env.RPC_ENDPOINTS_PATH, process.env.RPC_URL) });
  const connection = rpc.connection;
  await connection.getGenesisHash(); // Refuse wrong-chain configuration before accepting HTTP or ingestion.
  chainRoots = new ChainRoots(connection);
  const commitment = process.env.INGEST_COMMITMENT === "finalized" ? "finalized" : "confirmed";
  poller = new Poller(connection, store, undefined, undefined, commitment);
  const every = Number(process.env.POLL_MS ?? 15_000);
  // Backfill first, then poll; the in-flight guard keeps ticks from overlapping.
  poller
    .tick()
    .catch(() => console.error("indexer backfill failed; retrying from the saved cursor"))
    .finally(() => poller!.start(every));
  console.log(`indexer polling every ${every}ms`);
}

const server = buildServer(store, {
  webhookSecret: process.env.WEBHOOK_SECRET,
  chainRoots,
  poller: poller?.status,
});
server.listen(port, () => {
  console.log(`ghostlink indexer on :${port}${process.env.WEBHOOK_SECRET ? " (webhook on)" : ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    store.flush();
    process.exit(0);
  });
}
