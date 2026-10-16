//! Compiled-in Groth16 verifying keys.
//!
//! The two files below are GENERATED from circuits/keys/*_vk.json by
//! `cargo run -p ghostlink-verifier --bin gen-vk --features circom-vk`
//! (which scripts/build-circuits.sh runs for you). Dev keys come from a
//! throwaway phase 2; mainnet keys must come from the public ceremony and
//! be reproducible from its transcript (build plan, section 5).

pub mod login_vk;
pub mod owner_vk;
