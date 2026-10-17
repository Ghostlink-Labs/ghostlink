/** Context-bound tree evidence. This detects omitted tree history, not a dishonest RPC or missing Pocket events. */
import { createHash } from "node:crypto";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { bytes32ToField, FIELD_PRIME, ROOT_HISTORY_SIZE, TREE_DEPTH } from "@ghostlink/common";
import { CENSUS, REGISTRY } from "@ghostlink/service-kit";
import type { IndexerStore } from "./store.js";

export interface TreeHead { nextIndex: number; root: string }
export interface TreeHeads { registry: TreeHead; census: TreeHead }
export interface TreeAnchor extends TreeHeads { slot: number }
interface TreeEvidence extends TreeHead { roots: string[] }
const kinds = ["registry", "census"] as const;
const programs = [REGISTRY, CENSUS];
const addresses = [PublicKey.findProgramAddressSync([Buffer.from("tree")], REGISTRY)[0],
  PublicKey.findProgramAddressSync([Buffer.from("census")], CENSUS)[0]];
const rootsOffset = 16 + 32 * TREE_DEPTH;
const cursorOffset = rootsOffset + 32 * ROOT_HISTORY_SIZE;
const discriminator = createHash("sha256").update("account:TreeState").digest().subarray(0, 8);

export function assertAnchor(anchor: TreeAnchor): void {
  if (!anchor || !Number.isSafeInteger(anchor.slot) || anchor.slot < 0) throw new Error("invalid indexer tree anchor");
  for (const kind of kinds) {
    const head = anchor[kind];
    if (!head || !Number.isSafeInteger(head.nextIndex) || head.nextIndex < 0 || head.nextIndex > 2 ** TREE_DEPTH ||
      typeof head.root !== "string" || !/^(0|[1-9][0-9]{0,76})$/.test(head.root) || BigInt(head.root) >= FIELD_PRIME) {
      throw new Error("invalid indexer tree anchor");
    }
  }
}
function decode(info: AccountInfo<Buffer> | null, owner: PublicKey): TreeEvidence {
  if (!info || info.executable || !info.owner.equals(owner) || info.data.length !== cursorOffset + 8 ||
    !info.data.subarray(0, 8).equals(discriminator)) throw new Error("invalid on-chain tree account");
  const count = info.data.readBigUInt64LE(8), cursor = info.data[cursorOffset]!;
  if (count > 1n << BigInt(TREE_DEPTH) || cursor !== Number(count % BigInt(ROOT_HISTORY_SIZE))) throw new Error("invalid on-chain tree position");
  const roots = Array.from({ length: ROOT_HISTORY_SIZE }, (_, i) => bytes32ToField(info.data.subarray(rootsOffset + i * 32, rootsOffset + (i + 1) * 32)).toString());
  return { nextIndex: Number(count), root: roots[cursor]!, roots };
}
async function read(connection: Connection, commitment: "finalized" | "confirmed", minimumSlot: number) {
  const result = await connection.getMultipleAccountsInfoAndContext(addresses, { commitment, minContextSlot: minimumSlot });
  if (!Number.isSafeInteger(result.context.slot) || result.context.slot < minimumSlot || result.value.length !== 2) {
    throw new Error("tree account context is missing or regressed");
  }
  return { slot: result.context.slot, registry: decode(result.value[0]!, programs[0]!), census: decode(result.value[1]!, programs[1]!) };
}
export async function captureTreeAnchor(connection: Connection, minimumSlot: number): Promise<TreeAnchor> {
  const evidence = await read(connection, "finalized", minimumSlot);
  return { slot: evidence.slot, registry: { nextIndex: evidence.registry.nextIndex, root: evidence.registry.root },
    census: { nextIndex: evidence.census.nextIndex, root: evidence.census.root } };
}
export function storeHeads(store: IndexerStore): TreeHeads {
  return { registry: { nextIndex: store.registry.nextIndex, root: store.registry.root.toString() },
    census: { nextIndex: store.census.nextIndex, root: store.census.root.toString() } };
}
export function assertTreeMatch(anchor: TreeAnchor, heads: TreeHeads): void {
  assertAnchor(anchor);
  if (kinds.some(kind => anchor[kind].nextIndex !== heads[kind].nextIndex || anchor[kind].root !== heads[kind].root)) {
    throw new Error("indexed trees do not match finalized scan anchor; history reconciliation required");
  }
}
export async function rootsUsable(connection: Connection, anchor: TreeAnchor, minimumSlot: number): Promise<{ slot: number; usable: boolean }> {
  const current = await read(connection, "confirmed", Math.max(anchor.slot, minimumSlot));
  let usable = true;
  for (const kind of kinds) {
    const behind = current[kind].nextIndex - anchor[kind].nextIndex;
    if (behind < 0) throw new Error("confirmed tree regressed behind finalized anchor");
    if (behind >= ROOT_HISTORY_SIZE) usable = false;
    else if (current[kind].roots[anchor[kind].nextIndex % ROOT_HISTORY_SIZE] !== anchor[kind].root) {
      throw new Error("confirmed tree contradicts finalized anchor");
    }
  }
  return { slot: current.slot, usable };
}
