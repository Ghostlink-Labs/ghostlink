/**
 * Entry point. Environment:
 *   PORT (default 8789)
 *   OPERATIONS_PORT (default 18789, loopback only; must differ from PORT)
 *   SOLVER_MIN_BALANCE_LAMPORTS (default 5000000, at least maximum network fee)
 *   RPC_URL (default http://127.0.0.1:8899)
 *   RPC_ENDPOINTS_PATH — private JSON array of {url, headers?}; overrides RPC_URL
 *   GHOSTLINK_SOLVER_KEYPAIR — path to the solver keypair JSON
 *   SOLVER_JOURNAL_PATH — persistent SQLite path outside the repository
 *   SOLVER_JOURNAL_KEY_PATH — file with 32 raw random encryption-key bytes
 *   SOLVER_GENESIS_HASH — independently approved local-validator genesis
 *   PRICE_ACCOUNTS — JSON map of mint base58 -> Pyth price update account
 *   SOLVER_MAX_SPREAD_BPS — how far above the input's value a fill may go (default 100)
 *   SOLVER_ALLOW_UNPRICED=1 — fill output mints without a price (NFT-style)
 *   SOLVER_CREATE_POCKET_ATA=1 — pay rent for missing pocket output accounts
 *   SOLVER_MAX_COMPUTE_UNITS — cap full-fill compute (default 1400000)
 *   SOLVER_PRIORITY_MICRO_LAMPORTS — operator-fixed CU price (default 0)
 *   SOLVER_MAX_NETWORK_FEE_LAMPORTS — network fee ceiling, excludes rent (default 20000)
 *   SOLVER_ROUTER — inventory (default) or experimental jupiter-raydium-cp
 *   JUPITER_API_KEY_PATH — private text file, required for Jupiter
 *   JUPITER_POOLS_PATH — JSON array of explicitly approved classic-SPL pools
 *   JUPITER_SLIPPAGE_BPS — fixed quote tolerance, 0..500 (default 50)
 *   TRUST_PROXY=1 — honour X-Forwarded-For (only behind your own proxy)
 */
import { readFileSync, statSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { createRpcPool, loadRpcEndpoints } from "@ghostlink/service-kit/rpc";
import { buildServer, MockPlanner } from "./server.js";
import { SubmissionJournal } from "./journal.js";
import { POCKET_PROGRAM_ID } from "@ghostlink/common";
import { DEFAULT_TRANSACTION_LIMITS } from "./transactions.js";
import { JupiterPlanner } from "./jupiter.js";
import { operatorServer } from "./operations.js";

const keypairPath = process.env.GHOSTLINK_SOLVER_KEYPAIR;
if (!keypairPath) {
  console.error("GHOSTLINK_SOLVER_KEYPAIR is required (path to a keypair JSON outside the repo)");
  process.exit(1);
}
const journalPath = process.env.SOLVER_JOURNAL_PATH;
const journalKeyPath = process.env.SOLVER_JOURNAL_KEY_PATH;
const genesisHash = process.env.SOLVER_GENESIS_HASH;
if (!journalPath || !journalKeyPath || !genesisHash) throw new Error("SOLVER_JOURNAL_PATH, SOLVER_JOURNAL_KEY_PATH and approved SOLVER_GENESIS_HASH are required");
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))),
);
const rpc = createRpcPool({ genesisHash, endpoints: loadRpcEndpoints(process.env.RPC_ENDPOINTS_PATH, process.env.RPC_URL) });
const connection = rpc.connection;
if (await connection.getGenesisHash() !== genesisHash) throw new Error("RPC genesis differs from approved solver configuration");
const router = process.env.SOLVER_ROUTER ?? "inventory";
if (router !== "inventory" && router !== "jupiter-raydium-cp") throw new Error("unsupported SOLVER_ROUTER");
function privateText(name: string, maximum: number): string {
  const path = process.env[name];
  if (!path || !statSync(path).isFile() || statSync(path).size > maximum) throw new Error(`${name} must name a bounded configuration file`);
  return readFileSync(path, "utf8").trim();
}
const planner = router === "inventory" ? new MockPlanner() : new JupiterPlanner(connection, {
  apiKey: privateText("JUPITER_API_KEY_PATH", 512),
  pools: JSON.parse(privateText("JUPITER_POOLS_PATH", 32_768)),
  slippageBps: Number(process.env.JUPITER_SLIPPAGE_BPS ?? 50),
});
const journalKey = readFileSync(journalKeyPath);
const journal = new SubmissionJournal(journalPath, journalKey, { genesisHash, pocketProgram: POCKET_PROGRAM_ID, solver: keypair.publicKey.toBase58() });
journalKey.fill(0);
const priceAccounts = process.env.PRICE_ACCOUNTS
  ? (JSON.parse(process.env.PRICE_ACCOUNTS) as Record<string, string>)
  : {};
const port = Number(process.env.PORT ?? 8789);
const operationsPort = Number(process.env.OPERATIONS_PORT ?? 18789);
for (const n of [port, operationsPort]) if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("invalid solver HTTP port");
if (port === operationsPort) throw new Error("solver and operations ports must differ");

const server = buildServer({
  connection,
  keypair,
  planner,
  journal,
  transactionLimits: {
    maxComputeUnits: Number(process.env.SOLVER_MAX_COMPUTE_UNITS ?? DEFAULT_TRANSACTION_LIMITS.maxComputeUnits),
    priorityMicroLamports: BigInt(process.env.SOLVER_PRIORITY_MICRO_LAMPORTS ?? DEFAULT_TRANSACTION_LIMITS.priorityMicroLamports),
    maxNetworkFeeLamports: BigInt(process.env.SOLVER_MAX_NETWORK_FEE_LAMPORTS ?? DEFAULT_TRANSACTION_LIMITS.maxNetworkFeeLamports),
  },
  priceAccounts,
  maxQuoteSpreadBps: process.env.SOLVER_MAX_SPREAD_BPS ? Number(process.env.SOLVER_MAX_SPREAD_BPS) : undefined,
  allowUnpriced: process.env.SOLVER_ALLOW_UNPRICED === "1",
  createPocketAta: process.env.SOLVER_CREATE_POCKET_ATA === "1",
  trustProxy: process.env.TRUST_PROXY === "1",
  minimumBalanceLamports: Number(process.env.SOLVER_MIN_BALANCE_LAMPORTS ?? 5_000_000),
});
const operator = operatorServer(server.operations, rpc.status);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true; server.operations.drain();
  // A forced stop leaves exact packets in the journal for reconciliation.
  const deadline = setTimeout(() => {
    clearInterval(drainCheck);
    server.closeAllConnections(); operator.closeAllConnections(); rpc.close(); journal.close(); process.exit(1);
  }, 30_000);
  deadline.unref();
  let httpClosed = false;
  server.close(() => { httpClosed = true; });
  // Disconnected clients can leave preparation/submission work running after
  // Node's server-close callback. Keep its journal open until that work settles.
  const drainCheck = setInterval(() => {
    if (!httpClosed || server.operations.snapshot().active !== 0) return;
    clearInterval(drainCheck); clearTimeout(deadline);
    server.operations.stop(); rpc.close(); journal.close(); operator.close();
  }, 50);
  drainCheck.unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
operator.listen(operationsPort, "127.0.0.1");
server.listen(port, () => {
  console.log(`ghostlink solver on :${port}, identity ${keypair.publicKey.toBase58()}`);
});
