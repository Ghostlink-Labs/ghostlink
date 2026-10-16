/**
 * Entry point. Environment:
 *   PORT (default 8789)
 *   RPC_URL (default http://127.0.0.1:8899)
 *   GHOSTLINK_SOLVER_KEYPAIR — path to the solver keypair JSON
 *   SOLVER_JOURNAL_PATH — persistent SQLite path outside the repository
 *   SOLVER_JOURNAL_KEY_PATH — file with 32 raw random encryption-key bytes
 *   SOLVER_GENESIS_HASH — independently approved local-validator genesis
 *   PRICE_ACCOUNTS — JSON map of mint base58 -> Pyth price update account
 *   SOLVER_MAX_SPREAD_BPS — how far above the input's value a fill may go (default 100)
 *   SOLVER_ALLOW_UNPRICED=1 — fill output mints without a price (NFT-style)
 *   SOLVER_CREATE_POCKET_ATA=1 — pay rent for missing pocket output accounts
 *   TRUST_PROXY=1 — honour X-Forwarded-For (only behind your own proxy)
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { buildServer, MockPlanner } from "./server.js";
import { SubmissionJournal } from "./journal.js";
import { POCKET_PROGRAM_ID } from "@ghostlink/common";

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
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
if (await connection.getGenesisHash() !== genesisHash) throw new Error("RPC genesis differs from approved solver configuration");
const journalKey = readFileSync(journalKeyPath);
const journal = new SubmissionJournal(journalPath, journalKey, { genesisHash, pocketProgram: POCKET_PROGRAM_ID, solver: keypair.publicKey.toBase58() });
journalKey.fill(0);
const priceAccounts = process.env.PRICE_ACCOUNTS
  ? (JSON.parse(process.env.PRICE_ACCOUNTS) as Record<string, string>)
  : {};
const port = Number(process.env.PORT ?? 8789);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got ${process.env.PORT}`);

buildServer({
  connection,
  keypair,
  planner: new MockPlanner(),
  journal,
  priceAccounts,
  maxQuoteSpreadBps: process.env.SOLVER_MAX_SPREAD_BPS ? Number(process.env.SOLVER_MAX_SPREAD_BPS) : undefined,
  allowUnpriced: process.env.SOLVER_ALLOW_UNPRICED === "1",
  createPocketAta: process.env.SOLVER_CREATE_POCKET_ATA === "1",
  trustProxy: process.env.TRUST_PROXY === "1",
}).listen(port, () => {
  console.log(`ghostlink solver on :${port}, identity ${keypair.publicKey.toBase58()}`);
});
