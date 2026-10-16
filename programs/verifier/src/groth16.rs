//! Groth16 verification over the alt_bn128 syscalls via `groth16-solana`,
//! with the verifying keys compiled in. Public input order is fixed by
//! the circuits' `component main {public [...]}` lists — never reorder.

use crate::vks;
use crate::VerifierError;
use groth16_solana::groth16::Groth16Verifier;

/// login circuit public inputs, in order: registry_root, census_root,
/// domain_hash, app_id, mint_hi, mint_lo, threshold, min_slot,
/// session_commitment, home_hash, claim_holdings.
pub const LOGIN_PUBLIC_INPUTS: usize = 11;

/// owner circuit public inputs, in order: registry_root, domain_hash,
/// app_id, action_hash.
pub const OWNER_PUBLIC_INPUTS: usize = 4;

pub fn verify_login(
    proof_a: &[u8; 64],
    proof_b: &[u8; 128],
    proof_c: &[u8; 64],
    public_inputs: &[[u8; 32]; LOGIN_PUBLIC_INPUTS],
) -> Result<(), VerifierError> {
    let mut verifier = Groth16Verifier::new(
        proof_a,
        proof_b,
        proof_c,
        public_inputs,
        &vks::login_vk::VERIFYINGKEY,
    )
    .map_err(|_| VerifierError::ProofInvalid)?;
    verifier.verify().map_err(|_| VerifierError::ProofInvalid)
}

pub fn verify_owner(
    proof_a: &[u8; 64],
    proof_b: &[u8; 128],
    proof_c: &[u8; 64],
    public_inputs: &[[u8; 32]; OWNER_PUBLIC_INPUTS],
) -> Result<(), VerifierError> {
    let mut verifier = Groth16Verifier::new(
        proof_a,
        proof_b,
        proof_c,
        public_inputs,
        &vks::owner_vk::VERIFYINGKEY,
    )
    .map_err(|_| VerifierError::ProofInvalid)?;
    verifier.verify().map_err(|_| VerifierError::ProofInvalid)
}
