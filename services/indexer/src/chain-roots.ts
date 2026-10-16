/**
 * Reads the 128-root history rings straight from the on-chain TreeState
 * accounts, so the indexer can refuse any event whose root the chain
 * never had — the one check that ties this store to reality regardless
 * of who delivered the event.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { ROOT_HISTORY_SIZE, TREE_DEPTH } from "@ghostlink/common";
import { CENSUS, REGISTRY } from "@ghostlink/service-kit";

const ROOTS_OFFSET = 8 + 8 + 32 * TREE_DEPTH;
const CACHE_MS = 2_000;
const TREE_DISC = createHash("sha256").update("account:TreeState").digest().subarray(0, 8);

export class ChainRoots {
  private cache = new Map<string, { at: number; data: Uint8Array | null }>();
  private readonly accounts: Record<"registry" | "census", PublicKey>;

  constructor(private readonly connection: Connection) {
    this.accounts = {
      registry: PublicKey.findProgramAddressSync([Buffer.from("tree")], REGISTRY as PublicKey)[0],
      census: PublicKey.findProgramAddressSync([Buffer.from("census")], CENSUS as PublicKey)[0],
    };
  }

  async contains(kind: "registry" | "census", root: Uint8Array): Promise<boolean> {
    const data = await this.load(kind);
    if (this.hasRoot(data, root)) return true;
    // The ring may have advanced since a previous webhook populated the cache.
    // A stale negative must not acknowledge and discard a new append.
    this.cache.delete(kind);
    return this.hasRoot(await this.load(kind), root);
  }

  private hasRoot(data: Uint8Array | null, root: Uint8Array): boolean {
    if (root.length !== 32) return false;
    if (!data || data.length < ROOTS_OFFSET + 32 * ROOT_HISTORY_SIZE) return false;
    for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
      const off = ROOTS_OFFSET + i * 32;
      let same = true;
      for (let j = 0; j < 32; j++) {
        if (data[off + j] !== root[j]) {
          same = false;
          break;
        }
      }
      if (same) return true;
    }
    return false;
  }

  private async load(kind: "registry" | "census"): Promise<Uint8Array | null> {
    const hit = this.cache.get(kind);
    const now = Date.now();
    if (hit && now - hit.at < CACHE_MS) return hit.data;
    const info = await this.connection.getAccountInfo(this.accounts[kind], "confirmed");
    if (info && (!info.owner.equals(kind === "registry" ? REGISTRY : CENSUS) ||
      !TREE_DISC.every((b, i) => info.data[i] === b))) {
      throw new Error(`invalid ${kind} TreeState account`);
    }
    const data = info ? new Uint8Array(info.data) : null;
    this.cache.set(kind, { at: now, data });
    return data;
  }
}
