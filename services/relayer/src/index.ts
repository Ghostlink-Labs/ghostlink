/**
 * Entry point. Environment:
 *   PORT (default 8788)
 *   RPC_URL (default http://127.0.0.1:8899)
 *   GHOSTLINK_RELAYER_KEYPAIR — path to the fee payer keypair JSON
 *     (never in the repo; see docs/SETUP.md)
 *   RELAYER_DAILY_BUDGET_LAMPORTS — rolling 24 h spend ceiling (default 2 SOL)
 *   RELAYER_BUDGET_PATH — atomic spend snapshot; set to retain the budget across restarts
 *   RELAYER_ALLOWED_ORIGINS — comma-separated origins whose pockets this
 *     relayer will create; unset means any origin
 *   TRUST_PROXY=1 — honour X-Forwarded-For (only behind your own proxy)
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { domainHash, fieldToBytes32 } from "@ghostlink/common";
import { buildServer } from "./server.js";

const keypairPath = process.env.GHOSTLINK_RELAYER_KEYPAIR;
if (!keypairPath) {
  console.error("GHOSTLINK_RELAYER_KEYPAIR is required (path to a keypair JSON outside the repo)");
  process.exit(1);
}
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))),
);
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const port = Number(process.env.PORT ?? 8788);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got ${process.env.PORT}`);

const allowedOrigins = process.env.RELAYER_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);
const allowedDomainHashes = allowedOrigins?.length
  ? new Set(allowedOrigins.map((o) => Buffer.from(fieldToBytes32(domainHash(o))).toString("hex")))
  : undefined;

buildServer({
  connection,
  payer,
  dailyBudgetLamports: process.env.RELAYER_DAILY_BUDGET_LAMPORTS
    ? BigInt(process.env.RELAYER_DAILY_BUDGET_LAMPORTS)
    : undefined,
  allowedDomainHashes,
  budgetPersistPath: process.env.RELAYER_BUDGET_PATH,
  trustProxy: process.env.TRUST_PROXY === "1",
}).listen(port, () => {
  console.log(
    `ghostlink relayer on :${port}, payer ${payer.publicKey.toBase58()}` +
      (allowedDomainHashes ? ` (pockets for ${allowedDomainHashes.size} partner origins)` : ""),
  );
});
