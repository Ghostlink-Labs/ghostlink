/** Empty initialized protocol trees for HTTP-process fixtures; no live deployment data. */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { IncrementalTree, fieldToBytes32, ROOT_HISTORY_SIZE, TREE_DEPTH } from "@ghostlink/common";
import { REGISTRY, CENSUS } from "@ghostlink/service-kit";

export function emptyTreeAccounts(addresses) {
  const ids = [PublicKey.findProgramAddressSync([Buffer.from("tree")], REGISTRY)[0].toBase58(),
    PublicKey.findProgramAddressSync([Buffer.from("census")], CENSUS)[0].toBase58()];
  const data = Buffer.alloc(16 + TREE_DEPTH * 32 + ROOT_HISTORY_SIZE * 32 + 8);
  createHash("sha256").update("account:TreeState").digest().copy(data, 0, 0, 8);
  Buffer.from(fieldToBytes32(new IncrementalTree().root)).copy(data, 16 + TREE_DEPTH * 32);
  if (addresses.length !== 2 || addresses.some((address, i) => address !== ids[i])) throw new Error("unexpected tree fixture address");
  return [REGISTRY, CENSUS].map(owner => ({ owner: owner.toBase58(), executable: false, lamports: 1, rentEpoch: 0, data: [data.toString("base64"), "base64"] }));
}
