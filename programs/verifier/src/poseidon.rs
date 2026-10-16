//! Every Poseidon value the programs compute, mirroring
//! `packages/common/src/poseidon.ts`. Uses the `sol_poseidon` syscall on
//! chain (circomlib parameters over BN254) and the same parameters
//! natively in tests.

use crate::encoding::{split32, u64_fe, ONE_FE, ZERO_FE};
use crate::VerifierError;
use solana_poseidon::{hashv, Endianness, Parameters};

pub fn poseidon(inputs: &[&[u8]]) -> Result<[u8; 32], VerifierError> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, inputs)
        .map(|h| h.to_bytes())
        .map_err(|_| VerifierError::PoseidonFailed)
}

/// Internal Merkle node = Poseidon(left, right).
pub fn node(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], VerifierError> {
    poseidon(&[left, right])
}

/// L_reg = Poseidon(pk_hi, pk_lo, C).
pub fn registry_leaf(wallet: &[u8; 32], commitment: &[u8; 32]) -> Result<[u8; 32], VerifierError> {
    let (hi, lo) = split32(wallet);
    poseidon(&[&hi, &lo, commitment])
}

/// L_cen = Poseidon(pk_hi, pk_lo, mint_hi, mint_lo, amount, slot).
pub fn census_leaf(
    wallet: &[u8; 32],
    mint: &[u8; 32],
    amount: u64,
    slot: u64,
) -> Result<[u8; 32], VerifierError> {
    let (pk_hi, pk_lo) = split32(wallet);
    let (m_hi, m_lo) = split32(mint);
    poseidon(&[&pk_hi, &pk_lo, &m_hi, &m_lo, &u64_fe(amount), &u64_fe(slot)])
}

/// session_commitment = Poseidon(spk_hi, spk_lo, expiry_slot).
/// `session_key32` is the Ed25519 public key itself, or SHA-256 of the
/// 33-byte compressed P-256 key for passkey sessions.
pub fn session_commitment(session_key32: &[u8; 32], expiry_slot: u64) -> Result<[u8; 32], VerifierError> {
    let (hi, lo) = split32(session_key32);
    poseidon(&[&hi, &lo, &u64_fe(expiry_slot)])
}

/// home_hash = Poseidon(home_hi, home_lo).
pub fn home_hash(home: &[u8; 32]) -> Result<[u8; 32], VerifierError> {
    let (hi, lo) = split32(home);
    poseidon(&[&hi, &lo])
}

/// C = Poseidon(s, 0). Only tests ever call this on-chain-side code path;
/// the secret never reaches a program.
pub fn commitment(s_fe: &[u8; 32]) -> Result<[u8; 32], VerifierError> {
    poseidon(&[s_fe, &ZERO_FE])
}

/// app_id = Poseidon(s, domain_hash, 1). Test-only, like `commitment`.
pub fn app_id(s_fe: &[u8; 32], domain_hash: &[u8; 32]) -> Result<[u8; 32], VerifierError> {
    poseidon(&[s_fe, domain_hash, &ONE_FE])
}
