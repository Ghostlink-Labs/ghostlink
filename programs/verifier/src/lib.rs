//! Shared verification library for the GhostLink programs.
//!
//! In plain language: this crate is the part of the on-chain code that
//! checks the math — zero-knowledge proofs, the Poseidon hashes that build
//! identities and Merkle trees, and the exact bytes of a spending intent.
//! The registry and pocket programs link it in directly, so there is no
//! separate "verifier program" anyone could swap out from under them.

pub mod encoding;
pub mod groth16;
pub mod intent;
pub mod merkle;
pub mod poseidon;
pub mod vks;
pub mod zeros;

pub use groth16::{verify_login, verify_owner, LOGIN_PUBLIC_INPUTS, OWNER_PUBLIC_INPUTS};
pub use merkle::{RootRing, Frontier, ROOT_HISTORY, TREE_DEPTH};

#[derive(Debug, PartialEq, Eq)]
pub enum VerifierError {
    PoseidonFailed,
    InputNotInField,
    ProofInvalid,
    TreeFull,
}
