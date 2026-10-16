pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "lib/merkle.circom";

/*
 * The main GhostLink proof (build plan, circuit 1).
 *
 * Statement: "I know the secret s behind a commitment that sits in the
 * registry tree under wallet pk; app_id is derived from s and this app's
 * domain; and (if the holdings claim is on) that wallet had at least
 * `threshold` of `mint` in a census snapshot no older than `min_slot`."
 *
 * session_commitment and home_hash are public inputs with no in-circuit
 * constraints: including them in the statement binds them to the proof,
 * and the pocket program re-derives both from the raw instruction data.
 *
 * Public input order is the contract with the on-chain verifier —
 * never reorder without a coordinated program change.
 */
template Login(depth) {
    // ---- public ----
    signal input registry_root;
    signal input census_root;
    signal input domain_hash;
    signal input app_id;
    signal input mint_hi;
    signal input mint_lo;
    signal input threshold;
    signal input min_slot;
    signal input session_commitment;
    signal input home_hash;
    signal input claim_holdings;

    // ---- private ----
    signal input s;
    signal input pk_hi;
    signal input pk_lo;
    signal input reg_index;
    signal input reg_siblings[depth];
    signal input amount;
    signal input slot;
    signal input cen_index;
    signal input cen_siblings[depth];

    // claim_holdings is a bit.
    claim_holdings * (claim_holdings - 1) === 0;

    // C = Poseidon(s, 0)
    component cHash = Poseidon(2);
    cHash.inputs[0] <== s;
    cHash.inputs[1] <== 0;

    // L_reg = Poseidon(pk_hi, pk_lo, C) must sit in the registry tree.
    component regLeaf = Poseidon(3);
    regLeaf.inputs[0] <== pk_hi;
    regLeaf.inputs[1] <== pk_lo;
    regLeaf.inputs[2] <== cHash.out;

    component regPath = MerkleInclusion(depth);
    regPath.leaf <== regLeaf.out;
    regPath.index <== reg_index;
    for (var i = 0; i < depth; i++) regPath.siblings[i] <== reg_siblings[i];
    regPath.root === registry_root;

    // app_id = Poseidon(s, domain_hash, 1)
    component appIdHash = Poseidon(3);
    appIdHash.inputs[0] <== s;
    appIdHash.inputs[1] <== domain_hash;
    appIdHash.inputs[2] <== 1;
    appIdHash.out === app_id;

    // ---- holdings claim, enforced only when claim_holdings == 1 ----

    // Range-check the u64 quantities so the comparators below are sound.
    component amountBits = Num2Bits(64);
    amountBits.in <== amount;
    component slotBits = Num2Bits(64);
    slotBits.in <== slot;
    component thresholdBits = Num2Bits(64);
    thresholdBits.in <== threshold;
    component minSlotBits = Num2Bits(64);
    minSlotBits.in <== min_slot;

    // L_cen = Poseidon(pk_hi, pk_lo, mint_hi, mint_lo, amount, slot)
    component cenLeaf = Poseidon(6);
    cenLeaf.inputs[0] <== pk_hi;
    cenLeaf.inputs[1] <== pk_lo;
    cenLeaf.inputs[2] <== mint_hi;
    cenLeaf.inputs[3] <== mint_lo;
    cenLeaf.inputs[4] <== amount;
    cenLeaf.inputs[5] <== slot;

    component cenPath = MerkleInclusion(depth);
    cenPath.leaf <== cenLeaf.out;
    cenPath.index <== cen_index;
    for (var i = 0; i < depth; i++) cenPath.siblings[i] <== cen_siblings[i];
    // Gated: claim off => census inputs may be arbitrary.
    claim_holdings * (cenPath.root - census_root) === 0;

    // amount >= threshold
    component amountOk = GreaterEqThan(64);
    amountOk.in[0] <== amount;
    amountOk.in[1] <== threshold;
    claim_holdings * (1 - amountOk.out) === 0;

    // slot >= min_slot (snapshot fresh enough)
    component slotOk = GreaterEqThan(64);
    slotOk.in[0] <== slot;
    slotOk.in[1] <== min_slot;
    claim_holdings * (1 - slotOk.out) === 0;

    // Bind session_commitment and home_hash into the statement (no-op
    // constraints so no signal is dangling).
    signal sBind;
    sBind <== session_commitment * 1;
    signal hBind;
    hBind <== home_hash * 1;
}

component main {
    public [
        registry_root,
        census_root,
        domain_hash,
        app_id,
        mint_hi,
        mint_lo,
        threshold,
        min_slot,
        session_commitment,
        home_hash,
        claim_holdings
    ]
} = Login(26);
