//! Regenerates the compiled-in verifying keys from the snarkjs JSON
//! exports. Run from the repo root after scripts/build-circuits.sh:
//!
//!   cargo run -p ghostlink-verifier --bin gen-vk --features circom-vk

use groth16_solana::vk::circom::generate_vk_file;

fn main() {
    for name in ["login", "owner"] {
        let json = format!("circuits/keys/{name}_vk.json");
        let out = format!("{name}_vk.rs");
        generate_vk_file(&json, "programs/verifier/src/vks", &out)
            .unwrap_or_else(|e| panic!("generating {out} from {json}: {e:?}"));
        println!("wrote programs/verifier/src/vks/{out}");
    }
}
