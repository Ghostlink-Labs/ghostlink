/** Hosted indexer: finalized ordered history, scoped durable state, bounded work and drain. */
import { readFileSync } from "node:fs";
import { CENSUS, POCKET, REGISTRY } from "@ghostlink/service-kit";
import { createRpcPool, loadRpcEndpoints } from "@ghostlink/service-kit/rpc";
import { buildServer } from "./server.js";
import { IndexerStore } from "./store.js";
import { Poller } from "./poller.js";
import { IndexerDatabase } from "./database.js";

async function main() {
  const genesisHash = process.env.INDEXER_GENESIS_HASH, path = process.env.INDEXER_STATE_PATH, keyPath = process.env.INDEXER_STATE_KEY_PATH, stateId = process.env.INDEXER_STATE_ID;
  if (!genesisHash || !path || !keyPath || !stateId || (!process.env.RPC_URL && !process.env.RPC_ENDPOINTS_PATH)) throw new Error("approved indexer chain, RPC and pinned state are required");
  if (process.env.PERSIST_PATH) throw new Error("legacy indexer JSON requires an independently checked migration");
  if (process.env.INGEST_COMMITMENT && process.env.INGEST_COMMITMENT !== "finalized") throw new Error("hosted indexer requires finalized history");
  const port = Number(process.env.PORT ?? 8787), interval = Number(process.env.POLL_MS ?? 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(interval) || interval < 50 || interval > 30_000) throw new Error("invalid indexer service limits");
  const rpc = createRpcPool({ genesisHash, endpoints: loadRpcEndpoints(process.env.RPC_ENDPOINTS_PATH, process.env.RPC_URL) });
  let database: IndexerDatabase | undefined;
  try {
    await rpc.connection.getGenesisHash();
    const key = readFileSync(keyPath);
    try { database = IndexerDatabase.openExisting(path, key, JSON.stringify({ genesisHash, programs: [REGISTRY, CENSUS, POCKET].map(p => p.toBase58()), commitment: "finalized" }), stateId); }
    finally { key.fill(0); }
    const store = new IndexerStore(undefined, snapshot => database!.save(snapshot));
    const poller = new Poller(rpc.connection, store, undefined, undefined, "finalized", { database,
      maximumPages: Number(process.env.INDEXER_PAGES_PER_TICK ?? 4),
      maximumTransactions: Number(process.env.INDEXER_TRANSACTIONS_PER_TICK ?? 32),
      maximumTickMs: Number(process.env.INDEXER_TICK_BUDGET_MS ?? 10_000),
      paceMs: Number(process.env.INDEXER_PACE_MS ?? 120) });
    const poll = () => { void poller.tick().catch(() => console.error("indexer poll failed; retaining durable progress")); };
    const server = buildServer(store, { poller: poller.status, database, webhookSecret: process.env.WEBHOOK_SECRET, onIngestionHint: poll });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, resolve); });
    const timer = poller.start(interval), lease = setInterval(() => {
      try { database!.renew(); } catch { shutdown(true); }
    }, 15_000);
    let stopping = false;
    const shutdown = (failed = false) => {
      if (stopping) return;
      stopping = true; clearInterval(timer); clearInterval(lease); server.drain(); poller.drain(); server.close();
      const deadline = setTimeout(() => { server.closeAllConnections(); rpc.close(); database?.close(); process.exit(1); }, 30_000);
      deadline.unref();
      const wait = setInterval(() => {
        if (!poller.idle || server.active) return;
        clearInterval(wait); clearTimeout(deadline); server.closeAllConnections(); rpc.close(); database?.close();
        if (failed) process.exitCode = 1;
      }, 50);
    };
    process.once("SIGTERM", () => shutdown()); process.once("SIGINT", () => shutdown());
    poll(); console.log(`ghostlink indexer on :${port}`);
  } catch (error) { rpc.close(); database?.close(); throw error; }
}
void main().catch(() => { console.error("indexer startup failed; check approved configuration and state"); process.exitCode = 1; });
