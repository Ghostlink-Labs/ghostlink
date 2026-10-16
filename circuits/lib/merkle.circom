pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

/*
 * Poseidon Merkle inclusion for the incremental trees (depth 26 in v1).
 * `index` is the leaf index; bit i of it says whether our node is the
 * right child (1) or the left child (0) at level i.
 *
 * Outputs the root it computes; the caller decides what to compare it to
 * (equality for the registry, flag-gated equality for the census).
 */
template MerkleInclusion(depth) {
    signal input leaf;
    signal input index;
    signal input siblings[depth];
    signal output root;

    component bits = Num2Bits(depth);
    bits.in <== index;

    signal cur[depth + 1];
    signal left[depth];
    signal right[depth];
    component h[depth];

    cur[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        // bit == 0: (cur, sibling); bit == 1: (sibling, cur)
        left[i]  <== cur[i] + bits.out[i] * (siblings[i] - cur[i]);
        right[i] <== siblings[i] + bits.out[i] * (cur[i] - siblings[i]);
        h[i] = Poseidon(2);
        h[i].inputs[0] <== left[i];
        h[i].inputs[1] <== right[i];
        cur[i + 1] <== h[i].out;
    }
    root <== cur[depth];
}
