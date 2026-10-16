/**
 * Incremental append-only Merkle tree, Semaphore style (build plan section 5).
 *
 * The on-chain programs keep only a frontier of filled-subtree hashes plus
 * the next index. This class produces the same roots and additionally
 * keeps every level's nodes, so an append and an inclusion path each
 * cost O(depth) hashes — the indexer serves paths on the login hot path
 * and must not recompute the tree per request.
 */
import { FIELD_PRIME, FieldElement } from "./field.js";
import { merkleNode, zeroHashes } from "./poseidon.js";
import { TREE_DEPTH } from "./constants.js";

export interface MerklePath {
  /** Sibling hash per level, leaf level first. */
  siblings: FieldElement[];
  /** Leaf index; bit i gives the side at level i (0 = leaf on the left). */
  index: number;
}

export class IncrementalTree {
  readonly depth: number;
  readonly zeros: FieldElement[];
  /** levels[0] are the leaves; levels[depth] holds the root. */
  private levels: FieldElement[][];
  private _root: FieldElement;

  constructor(depth: number = TREE_DEPTH) {
    this.depth = depth;
    this.zeros = zeroHashes(depth);
    this.levels = Array.from({ length: depth + 1 }, () => []);
    this._root = this.zeros[depth]!;
  }

  get root(): FieldElement {
    return this._root;
  }

  get nextIndex(): number {
    return this.levels[0]!.length;
  }

  /** The leaf at `index`, if appended. */
  leafAt(index: number): FieldElement | undefined {
    return this.levels[0]![index];
  }

  /** The root the tree would have after appending `leaf`; no mutation. */
  rootAfterAppend(leaf: FieldElement): FieldElement {
    return this.walk(leaf, false);
  }

  /** Append a leaf; returns its index. Mirrors the on-chain algorithm. */
  append(leaf: FieldElement): number {
    const index = this.nextIndex;
    if (index >= 2 ** this.depth) throw new Error("tree is full");
    this._root = this.walk(leaf, true);
    return index;
  }

  private walk(leaf: FieldElement, write: boolean): FieldElement {
    const index = this.nextIndex;
    let cur = leaf;
    let idx = index;
    for (let level = 0; level < this.depth; level++) {
      const nodes = this.levels[level]!;
      if (write) nodes[idx] = cur;
      // An append only ever has a filled sibling on its left: the right
      // neighbour of an even index does not exist yet.
      cur =
        idx % 2 === 0
          ? merkleNode(cur, this.zeros[level]!)
          : merkleNode(nodes[idx - 1]!, cur);
      idx = Math.floor(idx / 2);
    }
    if (write) this.levels[this.depth]![0] = cur;
    return cur;
  }

  /** Inclusion path for a leaf: O(depth), read straight from the levels. */
  path(index: number): MerklePath {
    if (!Number.isInteger(index) || index < 0 || index >= this.nextIndex) {
      throw new Error("no such leaf");
    }
    const siblings: FieldElement[] = [];
    let idx = index;
    for (let level = 0; level < this.depth; level++) {
      siblings.push(this.levels[level]![idx ^ 1] ?? this.zeros[level]!);
      idx = Math.floor(idx / 2);
    }
    return { siblings, index };
  }

  static verify(leaf: FieldElement, path: MerklePath, root: FieldElement, depth: number = TREE_DEPTH): boolean {
    if (!Number.isInteger(path.index) || path.index < 0 || path.index >= 2 ** depth) return false;
    if (path.siblings.length !== depth) return false;
    if (leaf < 0n || leaf >= FIELD_PRIME || root < 0n || root >= FIELD_PRIME) return false;
    let cur = leaf;
    let idx = path.index;
    for (let level = 0; level < depth; level++) {
      const sib = path.siblings[level]!;
      if (sib < 0n || sib >= FIELD_PRIME) return false;
      cur = idx % 2 === 0 ? merkleNode(cur, sib) : merkleNode(sib, cur);
      idx = Math.floor(idx / 2);
    }
    return cur === root;
  }
}
