/** Hosted payer: an approved chain, private key and durable encrypted journal are mandatory. */
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { createRpcPool, loadRpcEndpoints } from "@ghostlink/service-kit/rpc";
import { POCKET, REGISTRY, CENSUS } from "@ghostlink/service-kit";
import { domainHash, fieldToBytes32 } from "@ghostlink/common";
import { buildServer } from "./server.js";
import { RelayerJournal } from "./journal.js";

async function main() {
  const keypairPath = process.env.GHOSTLINK_RELAYER_KEYPAIR;
  const genesisHash = process.env.RELAYER_GENESIS_HASH;
  const journalPath = process.env.RELAYER_JOURNAL_PATH, journalKeyPath = process.env.RELAYER_JOURNAL_KEY_PATH;
  if (!keypairPath || !genesisHash || !journalPath || !journalKeyPath) throw new Error("relayer payer, chain and journal configuration required");
  // No automatic migration can prove whether an old ambiguous send was accepted.
  if (process.env.RELAYER_BUDGET_PATH) throw new Error("legacy spend state requires reconciliation before switching to the journal");
  const port = Number(process.env.PORT ?? 8788);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("invalid relayer port");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
  const rpc = createRpcPool({ genesisHash, endpoints: loadRpcEndpoints(process.env.RPC_ENDPOINTS_PATH, process.env.RPC_URL) });
  let journal: RelayerJournal | undefined;
  try {
    await rpc.connection.getGenesisHash();
    const key = readFileSync(journalKeyPath);
    try { journal = new RelayerJournal(journalPath, key, { genesisHash, payer: payer.publicKey.toBase58(),
      pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58() },
      BigInt(process.env.RELAYER_DAILY_BUDGET_LAMPORTS ?? "2000000000")); }
    finally { key.fill(0); }
    const origins = process.env.RELAYER_ALLOWED_ORIGINS?.split(",").map(s => s.trim()).filter(Boolean);
    const server = buildServer({ connection: rpc.connection, payer, journal,
      allowedDomainHashes: origins?.length ? new Set(origins.map(o => Buffer.from(fieldToBytes32(domainHash(o))).toString("hex"))) : undefined,
      trustProxy: process.env.TRUST_PROXY === "1" });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, resolve); });
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true; server.drain(); server.close();
      const deadline = setTimeout(() => { server.closeAllConnections(); rpc.close(); journal?.close(); process.exit(1); }, 30_000);
      deadline.unref();
      const wait = setInterval(() => {
        if (server.active) return;
        clearInterval(wait); clearTimeout(deadline); server.closeAllConnections(); rpc.close(); journal?.close();
      }, 50);
    };
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    console.log(`ghostlink relayer on :${port}, payer ${payer.publicKey.toBase58()}`);
  } catch (error) { rpc.close(); journal?.close(); throw error; }
}
void main().catch(() => { console.error("relayer startup failed; check approved configuration, legacy migration and dependencies"); process.exitCode = 1; });
