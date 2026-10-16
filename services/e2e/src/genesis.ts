/**
 * Generates genesis account files for solana-test-validator: two fake
 * Pyth PriceUpdateV2 accounts (USDC at $1.00, SOL-token at $156.25) at
 * deterministic addresses, owned by the Pyth receiver program. Localnet
 * has no real Pyth, and these accounts can only exist at genesis because
 * only the receiver program could create them later.
 *
 * Usage: node dist/genesis.js <outDir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";

export const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const PRICE_UPDATE_V2_DISC = [34, 241, 35, 99, 157, 126, 244, 205];

export const label = (name: string): Uint8Array =>
  sha256(new TextEncoder().encode(`ghostlink vector: ${name}`));

export const priceAccountFor = (tag: string) => Keypair.fromSeed(label(tag)).publicKey;

export function pythAccountData(feedId: Uint8Array, price: bigint, exponent: number, publishTime: bigint): Buffer {
  const buf = Buffer.alloc(8 + 32 + 1 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
  let off = 0;
  Buffer.from(PRICE_UPDATE_V2_DISC).copy(buf, off);
  off += 8;
  off += 32; // write authority: zeros
  buf[off] = 1; // VerificationLevel::Full
  off += 1;
  Buffer.from(feedId).copy(buf, off);
  off += 32;
  buf.writeBigInt64LE(price, off);
  off += 8;
  buf.writeBigUInt64LE(0n, off); // conf
  off += 8;
  buf.writeInt32LE(exponent, off);
  off += 4;
  buf.writeBigInt64LE(publishTime, off);
  off += 8;
  buf.writeBigInt64LE(publishTime, off); // prev publish time
  off += 8;
  buf.writeBigInt64LE(price, off); // ema price
  off += 8;
  buf.writeBigUInt64LE(0n, off); // ema conf
  return buf;
}

export function writeGenesisAccounts(outDir: string): { usdcPrice: string; solPrice: string } {
  mkdirSync(outDir, { recursive: true });
  // Far-future publish time keeps the staleness check quiet for the run.
  const publishTime = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  const entries = [
    {
      file: "usdc-price.json",
      pubkey: priceAccountFor("e2e usdc price acct"),
      data: pythAccountData(label("usdc pyth feed"), 100_000_000n, -8, publishTime),
    },
    {
      file: "sol-price.json",
      pubkey: priceAccountFor("e2e sol price acct"),
      data: pythAccountData(label("sol pyth feed"), 15_625_000_000n, -8, publishTime),
    },
  ];
  for (const e of entries) {
    writeFileSync(
      join(outDir, e.file),
      JSON.stringify({
        pubkey: e.pubkey.toBase58(),
        account: {
          lamports: 10_000_000,
          data: [e.data.toString("base64"), "base64"],
          owner: PYTH_RECEIVER,
          executable: false,
          rentEpoch: 0,
        },
      }),
    );
  }
  return {
    usdcPrice: entries[0]!.pubkey.toBase58(),
    solPrice: entries[1]!.pubkey.toBase58(),
  };
}

const isMain = process.argv[1]?.endsWith("genesis.js");
if (isMain) {
  const out = process.argv[2] ?? ".genesis";
  const accounts = writeGenesisAccounts(out);
  console.log(JSON.stringify(accounts, null, 2));
}
