/** Explicit synthetic genesis state for testing a mature timelock without waiting 24 hours. */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { conservativePolicy } from "@ghostlink/common";
import { BorshWriter, POCKET, POCKET_ACCOUNT_SIZE, writePolicy } from "@ghostlink/service-kit";

const seed = (value: string) => createHash("sha256").update(`ghostlink watcher fixture:${value}`).digest();
export function watcherGenesis() {
  return ["mature", "future"].map(kind => {
    const appId = seed(kind), [pocket, bump] = PublicKey.findProgramAddressSync([Buffer.from("pocket"), appId], POCKET);
    const home = Keypair.fromSeed(seed(`${kind}:home`)).publicKey, newHome = Keypair.fromSeed(seed(`${kind}:new-home`)).publicKey;
    return { kind, appId, pocket, bump, home, newHome, after: kind === "mature" ? 0n : 1_000_000n };
  });
}

export function writeWatcherGenesis(directory: string) {
  for (const fixture of watcherGenesis()) {
    const writer = new BorshWriter().fixed(createHash("sha256").update("account:PocketV3").digest().subarray(0, 8))
      .fixed(fixture.appId).fixed(new Uint8Array(32)).fixed(fixture.home.toBytes()).u8(0).fixed(new Uint8Array(33)).u64(0n);
    writePolicy(writer, conservativePolicy());
    writer.u8(1).u8(0).fixed(fixture.newHome.toBytes()).u64(fixture.after)
      .u64(0n).u64(0n).fixed(new Uint8Array(256)).u8(fixture.bump).u64(0n).u64(0n).u64(0n);
    const data = Buffer.alloc(POCKET_ACCOUNT_SIZE); data.set(writer.out());
    writeFileSync(join(directory, `watcher-${fixture.kind}.json`), JSON.stringify({ pubkey: fixture.pocket.toBase58(),
      account: { lamports: 100_000_000, data: [data.toString("base64"), "base64"], owner: POCKET.toBase58(), executable: false, rentEpoch: 0 } }));
  }
}
