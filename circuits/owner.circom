pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "lib/merkle.circom";

/*
 * The owner proof (build plan, circuit 2): sweep, policy and home changes,
 * session revoke. Proves the same registry binding as `login` without any
 * census claim, and binds `action_hash` — the hash of the instruction
 * payload — so a proof cannot be replayed for a different action.
 */
template Owner(depth) {
    // ---- public ----
    signal input registry_root;
    signal input domain_hash;
    signal input app_id;
    signal input action_hash;

    // ---- private ----
    signal input s;
    signal input pk_hi;
    signal input pk_lo;
    signal input reg_index;
    signal input reg_siblings[depth];

    component cHash = Poseidon(2);
    cHash.inputs[0] <== s;
    cHash.inputs[1] <== 0;

    component regLeaf = Poseidon(3);
    regLeaf.inputs[0] <== pk_hi;
    regLeaf.inputs[1] <== pk_lo;
    regLeaf.inputs[2] <== cHash.out;

    component regPath = MerkleInclusion(depth);
    regPath.leaf <== regLeaf.out;
    regPath.index <== reg_index;
    for (var i = 0; i < depth; i++) regPath.siblings[i] <== reg_siblings[i];
    regPath.root === registry_root;

    component appIdHash = Poseidon(3);
    appIdHash.inputs[0] <== s;
    appIdHash.inputs[1] <== domain_hash;
    appIdHash.inputs[2] <== 1;
    appIdHash.out === app_id;

    // Bind the action so the proof authorizes exactly one payload.
    signal aBind;
    aBind <== action_hash * 1;
}

component main {
    public [registry_root, domain_hash, app_id, action_hash]
} = Owner(26);
