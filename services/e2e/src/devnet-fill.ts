/**
 * Runs the full e2e with the oracle-checked fill ENABLED on devnet,
 * against Pyth's sponsored push-feed accounts (shard 0) that already
 * live on-chain — fresh SOL/USD and USDC/USD PriceUpdateV2 accounts the
 * pocket's own read_price parses directly. The policy binds our test
 * mints to the real feed ids, so the on-chain slippage floor is checked
 * against live market prices.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR = process.env.PAYER_KEYPAIR ?? join(homedir(), ".ghostlink/keys/deployer.json");
const PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const PRICE_UPDATE_V2_DISC = [34, 241, 35, 99, 157, 126, 244, 205];
const MAX_AGE = 90; // the pocket allows 60s; pick a shard well inside it

const FEEDS = {
  sol: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  usdc: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
};

interface Feed {
  account: string;
  price: bigint;
  expo: number;
  ageSec: number;
}

function pushPda(feedHex: string, shard: number): PublicKey {
  const shardBuf = Buffer.alloc(2);
  shardBuf.writeUInt16LE(shard);
  return PublicKey.findProgramAddressSync(
    [shardBuf, Buffer.from(feedHex, "hex")],
    PUSH_ORACLE,
  )[0];
}

/** Picks the freshest shard that parses as a Full update for this feed. */
async function freshest(connection: Connection, feedHex: string): Promise<Feed> {
  let best: Feed | null = null;
  for (const shard of [0, 1, 2, 3]) {
    const pda = pushPda(feedHex, shard);
    const info = await connection.getAccountInfo(pda);
    if (!info || info.owner.toBase58() !== RECEIVER) continue;
    const d = info.data;
    if (![...d.subarray(0, 8)].every((b, i) => b === PRICE_UPDATE_V2_DISC[i])) continue;
    let off = 8 + 32;
    const level = d[off]!;
    if (level !== 1) continue; // Full only
    off += 1;
    if (d.subarray(off, off + 32).toString("hex") !== feedHex) continue;
    off += 32;
    const price = d.readBigInt64LE(off);
    off += 8 + 8;
    const expo = d.readInt32LE(off);
    off += 4;
    const publishTime = Number(d.readBigInt64LE(off));
    const ageSec = Math.floor(Date.now() / 1000) - publishTime;
    if (price <= 0n) continue;
    if (!best || ageSec < best.ageSec) best = { account: pda.toBase58(), price, expo, ageSec };
  }
  if (!best) throw new Error(`no live Pyth push account for ${feedHex.slice(0, 10)}…`);
  return best;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const sol = await freshest(connection, FEEDS.sol);
  const usdc = await freshest(connection, FEEDS.usdc);
  const solUsd = Number(sol.price) * 10 ** sol.expo;
  console.log(`SOL/USD = $${solUsd.toFixed(2)} (shard acct ${sol.account.slice(0, 8)}…, age ${sol.ageSec}s)`);
  console.log(`USDC/USD = $${(Number(usdc.price) * 10 ** usdc.expo).toFixed(4)} (age ${usdc.ageSec}s)`);

  if (sol.ageSec > MAX_AGE || usdc.ageSec > MAX_AGE) {
    console.log(`note: a feed is older than ${MAX_AGE}s now; the runner waits for both to refresh before the fill`);
  }
  // Provisional sizing; the runner recomputes out_min from the live
  // on-chain price immediately before the fill.
  const outMin = Math.floor((25 / solUsd) * 1e9 * 1.004);

  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [join(here, "run.js")], {
    stdio: "inherit",
    env: {
      ...process.env,
      RPC_URL: RPC,
      PAYER_KEYPAIR: KEYPAIR,
      REPO_ROOT: process.env.REPO_ROOT ?? join(here, "..", "..", ".."),
      SKIP_FILL: "0",
      FEED_SOL_ID: FEEDS.sol,
      FEED_USDC_ID: FEEDS.usdc,
      PRICE_ACCT_SOL: sol.account,
      PRICE_ACCT_USDC: usdc.account,
      OUT_MIN: String(outMin),
      PYTH_WAIT: "1",
    },
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

main().catch((e) => {
  console.error("devnet-fill failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
