/**
 * Entry point. Environment:
 *   PORT (default 8790)
 *   RPC_URL (default http://127.0.0.1:8899)
 *   BASE_URL — public origin of this endpoint (for Blink metadata links)
 *   CLUSTER — devnet (default) or mainnet-beta, for the X-Blockchain-Ids header
 */
import { Connection } from "@solana/web3.js";
import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 8790);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got ${process.env.PORT}`);
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
const cluster = process.env.CLUSTER === "mainnet-beta" ? "mainnet-beta" : "devnet";

buildServer({ connection, baseUrl, cluster }).listen(port, () => {
  console.log(`ghostlink actions on :${port} (${cluster})`);
});
