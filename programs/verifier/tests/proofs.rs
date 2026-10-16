//! Cross-stack proof check (build plan, test layer 2): the proofs produced
//! by snarkjs over the fixture inputs must verify through groth16-solana
//! with the compiled-in verifying keys — the exact code path the programs
//! run on-chain. Skips politely when scripts/build-circuits.sh has not
//! been run.

use ghostlink_verifier::{verify_login, verify_owner, LOGIN_PUBLIC_INPUTS, OWNER_PUBLIC_INPUTS};
use num_bigint::BigUint;
use serde_json::Value;

/// BN254 base-field modulus (Fq), for negating proof A's y coordinate.
fn fq() -> BigUint {
    BigUint::parse_bytes(
        b"21888242871839275222246405745257275088696311157297823662689037894645226208583",
        10,
    )
    .unwrap()
}

fn be32(n: &BigUint) -> [u8; 32] {
    let bytes = n.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

fn dec(v: &Value) -> BigUint {
    BigUint::parse_bytes(v.as_str().unwrap().as_bytes(), 10).unwrap()
}

/// snarkjs proof JSON -> (negated A, B as c1||c0 pairs, C), all big-endian.
fn convert(proof: &Value) -> ([u8; 64], [u8; 128], [u8; 64]) {
    let ax = dec(&proof["pi_a"][0]);
    let ay = dec(&proof["pi_a"][1]);
    let neg_ay = if ay == BigUint::from(0u8) { ay.clone() } else { fq() - &ay % fq() };

    let mut a = [0u8; 64];
    a[..32].copy_from_slice(&be32(&ax));
    a[32..].copy_from_slice(&be32(&neg_ay));

    let mut b = [0u8; 128];
    b[..32].copy_from_slice(&be32(&dec(&proof["pi_b"][0][1]))); // x_c1
    b[32..64].copy_from_slice(&be32(&dec(&proof["pi_b"][0][0]))); // x_c0
    b[64..96].copy_from_slice(&be32(&dec(&proof["pi_b"][1][1]))); // y_c1
    b[96..].copy_from_slice(&be32(&dec(&proof["pi_b"][1][0]))); // y_c0

    let mut c = [0u8; 64];
    c[..32].copy_from_slice(&be32(&dec(&proof["pi_c"][0])));
    c[32..].copy_from_slice(&be32(&dec(&proof["pi_c"][1])));

    (a, b, c)
}

fn load(name: &str) -> Option<Value> {
    let path = format!(
        "{}/../../circuits/keys/{name}_proof.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

#[test]
fn login_proof_verifies_in_rust() {
    let Some(fixture) = load("login") else {
        eprintln!("skipping: run scripts/build-circuits.sh first");
        return;
    };
    let (a, b, c) = convert(&fixture["proof"]);
    let signals = fixture["publicSignals"].as_array().unwrap();
    assert_eq!(signals.len(), LOGIN_PUBLIC_INPUTS);
    let mut inputs = [[0u8; 32]; LOGIN_PUBLIC_INPUTS];
    for (i, s) in signals.iter().enumerate() {
        inputs[i] = be32(&dec(s));
    }
    verify_login(&a, &b, &c, &inputs).expect("login proof must verify");

    // Tampering with any public input must break it.
    let mut bad = inputs;
    bad[3][31] ^= 1; // app_id
    assert!(verify_login(&a, &b, &c, &bad).is_err());

    // Tampering with the proof must break it.
    let mut bad_a = a;
    bad_a[10] ^= 1;
    assert!(verify_login(&bad_a, &b, &c, &inputs).is_err());
}

/// The TypeScript converter's bytes (proofToBytes in @ghostlink/common,
/// emitted into the fixture by prove-fixtures.mjs) must verify through
/// the same on-chain code path — proving the browser-side byte layout.
#[test]
fn typescript_converted_bytes_verify() {
    let Some(fixture) = load("login") else {
        eprintln!("skipping: run scripts/build-circuits.sh first");
        return;
    };
    let Some(bytes) = fixture.get("bytes") else {
        eprintln!("skipping: fixture predates the bytes field; rerun prove-fixtures");
        return;
    };
    let hexd = |s: &str| -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    };
    let a: [u8; 64] = hexd(bytes["a"].as_str().unwrap()).try_into().unwrap();
    let b: [u8; 128] = hexd(bytes["b"].as_str().unwrap()).try_into().unwrap();
    let c: [u8; 64] = hexd(bytes["c"].as_str().unwrap()).try_into().unwrap();
    let signals = fixture["publicSignals"].as_array().unwrap();
    let mut inputs = [[0u8; 32]; LOGIN_PUBLIC_INPUTS];
    for (i, s) in signals.iter().enumerate() {
        inputs[i] = be32(&dec(s));
    }
    verify_login(&a, &b, &c, &inputs).expect("TS-converted proof bytes must verify");
}

#[test]
fn owner_proof_verifies_in_rust() {
    let Some(fixture) = load("owner") else {
        eprintln!("skipping: run scripts/build-circuits.sh first");
        return;
    };
    let (a, b, c) = convert(&fixture["proof"]);
    let signals = fixture["publicSignals"].as_array().unwrap();
    assert_eq!(signals.len(), OWNER_PUBLIC_INPUTS);
    let mut inputs = [[0u8; 32]; OWNER_PUBLIC_INPUTS];
    for (i, s) in signals.iter().enumerate() {
        inputs[i] = be32(&dec(s));
    }
    verify_owner(&a, &b, &c, &inputs).expect("owner proof must verify");

    let mut bad = inputs;
    bad[2][31] ^= 1;
    assert!(verify_owner(&a, &b, &c, &bad).is_err());
}
