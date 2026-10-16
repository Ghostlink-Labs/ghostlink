//! Vector tests: Rust must reproduce packages/common/fixtures/vectors.json
//! byte for byte (build plan, test layer 1). If these fail, the TypeScript
//! and Rust stacks disagree about the protocol.

use ghostlink_verifier::encoding::{is_in_field, split32, u64_fe};
use ghostlink_verifier::intent::Intent;
use ghostlink_verifier::merkle::{empty_root, Frontier, RootRing, ROOT_HISTORY, TREE_DEPTH};
use ghostlink_verifier::poseidon;
use ghostlink_verifier::zeros::ZEROS;
use num_bigint::BigUint;
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/common/fixtures/vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixtures missing")).unwrap()
}

/// Decimal field-element string -> 32 big-endian bytes.
fn fe(s: &str) -> [u8; 32] {
    let n = BigUint::parse_bytes(s.as_bytes(), 10).unwrap();
    let bytes = n.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
}

#[test]
fn field_split_matches() {
    let v = vectors();
    let input = hex32(v["field"]["split"]["input"].as_str().unwrap());
    let (hi, lo) = split32(&input);
    assert_eq!(hi, fe(v["field"]["split"]["hi"].as_str().unwrap()));
    assert_eq!(lo, fe(v["field"]["split"]["lo"].as_str().unwrap()));
}

#[test]
fn field_membership() {
    let v = vectors();
    assert!(is_in_field(&fe(v["identity"]["commitment"].as_str().unwrap())));
    // The modulus itself and anything above must be rejected.
    let modulus = fe(v["field"]["prime"].as_str().unwrap());
    assert!(!is_in_field(&modulus));
    assert!(!is_in_field(&[0xff; 32]));
    assert!(is_in_field(&[0u8; 32]));
}

#[test]
fn identity_values_match() {
    let v = vectors();
    let id = &v["identity"];
    let s_fe = fe(id["sField"].as_str().unwrap());
    let wallet = hex32(id["walletPubkey"].as_str().unwrap());

    let c = poseidon::commitment(&s_fe).unwrap();
    assert_eq!(c, fe(id["commitment"].as_str().unwrap()));

    let leaf = poseidon::registry_leaf(&wallet, &c).unwrap();
    assert_eq!(leaf, fe(id["registryLeaf"].as_str().unwrap()));

    let domain = fe(id["domainHash"].as_str().unwrap());
    let app = poseidon::app_id(&s_fe, &domain).unwrap();
    assert_eq!(app, fe(id["appId"].as_str().unwrap()));

    let spk = hex32(id["sessionPubkey"].as_str().unwrap());
    let expiry: u64 = id["expirySlot"].as_str().unwrap().parse().unwrap();
    let sess = poseidon::session_commitment(&spk, expiry).unwrap();
    assert_eq!(sess, fe(id["sessionCommitment"].as_str().unwrap()));

    let home = hex32(id["homeAddress"].as_str().unwrap());
    assert_eq!(
        poseidon::home_hash(&home).unwrap(),
        fe(id["homeHash"].as_str().unwrap())
    );
}

#[test]
fn census_leaf_matches() {
    let v = vectors();
    let wallet = hex32(v["identity"]["walletPubkey"].as_str().unwrap());
    let mint = hex32(v["census"]["mint"].as_str().unwrap());
    let amount: u64 = v["census"]["amount"].as_str().unwrap().parse().unwrap();
    let slot: u64 = v["census"]["slot"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        poseidon::census_leaf(&wallet, &mint, amount, slot).unwrap(),
        fe(v["census"]["leaf"].as_str().unwrap())
    );
}

#[test]
fn zeros_constants_match_fixtures_and_recomputation() {
    let v = vectors();
    let zeros_fx: Vec<[u8; 32]> = v["merkle"]["zeros"]
        .as_array()
        .unwrap()
        .iter()
        .map(|z| fe(z.as_str().unwrap()))
        .collect();
    assert_eq!(zeros_fx.len(), TREE_DEPTH + 1);
    for (i, z) in zeros_fx.iter().enumerate() {
        assert_eq!(&ZEROS[i], z, "zeros[{i}] drifted");
    }
    // Recompute the chain from scratch.
    let mut cur = poseidon::poseidon(&[&[0u8; 32], &[0u8; 32]]).unwrap();
    assert_eq!(cur, ZEROS[0]);
    for i in 1..=TREE_DEPTH {
        cur = poseidon::node(&cur, &cur.clone()).unwrap();
        assert_eq!(cur, ZEROS[i], "recomputed zeros[{i}]");
    }
    assert_eq!(empty_root(), ZEROS[TREE_DEPTH]);
}

#[test]
fn frontier_append_matches_fixture_roots() {
    let v = vectors();
    let mut next_index = 0u64;
    let mut frontier = [[0u8; 32]; TREE_DEPTH];
    let mut f = Frontier {
        next_index: &mut next_index,
        frontier: &mut frontier,
    };
    let leaves: Vec<[u8; 32]> = v["merkle"]["appended"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| fe(l.as_str().unwrap()))
        .collect();
    let expected: Vec<[u8; 32]> = v["merkle"]["rootsAfterEachAppend"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| fe(r.as_str().unwrap()))
        .collect();
    for (leaf, want) in leaves.iter().zip(expected.iter()) {
        let root = f.append(*leaf).unwrap();
        assert_eq!(&root, want);
    }
    assert_eq!(next_index, 3);
}

#[test]
fn root_ring_pushes_and_finds() {
    let mut roots = [[0u8; 32]; ROOT_HISTORY];
    let mut cursor = 0u8;
    let mut ring = RootRing {
        roots: &mut roots,
        cursor: &mut cursor,
    };
    for i in 0..200u32 {
        let mut r = [0u8; 32];
        r[28..].copy_from_slice(&i.to_be_bytes());
        ring.push(r);
    }
    let mut recent = [0u8; 32];
    recent[28..].copy_from_slice(&199u32.to_be_bytes());
    let mut evicted = [0u8; 32];
    evicted[28..].copy_from_slice(&10u32.to_be_bytes());
    assert!(ring.contains(&recent));
    assert!(!ring.contains(&evicted));
}

#[test]
fn intent_bytes_and_hash_match() {
    let v = vectors();
    let f = &v["intent"]["fields"];
    let intent = Intent {
        pocket: hex32(f["pocket"].as_str().unwrap()),
        nonce: f["nonce"].as_str().unwrap().parse().unwrap(),
        in_mint: hex32(f["inMint"].as_str().unwrap()),
        in_max: f["inMax"].as_str().unwrap().parse().unwrap(),
        out_mint: hex32(f["outMint"].as_str().unwrap()),
        out_min: f["outMin"].as_str().unwrap().parse().unwrap(),
        deadline_slot: f["deadlineSlot"].as_str().unwrap().parse().unwrap(),
        policy_hash: hex32(f["policyHash"].as_str().unwrap()),
    };
    let bytes = intent.to_bytes();
    let want_hex = v["intent"]["bytes"].as_str().unwrap();
    assert_eq!(bytes.len() * 2, want_hex.len());
    let got_hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(got_hex, want_hex);

    // The programs hash these bytes with the runtime's sha256 syscall;
    // check the expected digest with a host-side sha2 here.
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let digest_hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(digest_hex, v["intent"]["hash"].as_str().unwrap());
}
