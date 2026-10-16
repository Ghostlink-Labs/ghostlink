/** Inspects Pyth's sponsored push-feed accounts on devnet: owner,
 * discriminator, feed id, price, exponent, publish time freshness. */
import { Connection, PublicKey } from "@solana/web3.js";

const PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const FEEDS = {
  "SOL/USD": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "USDC/USD": "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
};

const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");

for (const [name, idHex] of Object.entries(FEEDS)) {
  const feedId = Buffer.from(idHex, "hex");
  for (const shard of [0, 1]) {
    const shardBuf = Buffer.alloc(2);
    shardBuf.writeUInt16LE(shard);
    const [pda] = PublicKey.findProgramAddressSync([shardBuf, feedId], PUSH_ORACLE);
    const info = await connection.getAccountInfo(pda);
    if (!info) {
      console.log(`${name} shard ${shard}: ${pda.toBase58()} — no account`);
      continue;
    }
    const d = info.data;
    const disc = [...d.subarray(0, 8)].join(",");
    let off = 8 + 32;
    const level = d[off];
    off += level === 0 ? 2 : 1;
    const gotFeed = d.subarray(off, off + 32).toString("hex");
    off += 32;
    const price = d.readBigInt64LE(off);
    off += 8;
    off += 8; // conf
    const expo = d.readInt32LE(off);
    off += 4;
    const publishTime = d.readBigInt64LE(off);
    const age = Math.floor(Date.now() / 1000) - Number(publishTime);
    console.log(
      `${name} shard ${shard}: ${pda.toBase58()}\n  owner=${info.owner.toBase58()}\n  disc=[${disc}] level=${level} feedMatch=${gotFeed === idHex}\n  price=${price} expo=${expo} publishAge=${age}s`,
    );
  }
}
