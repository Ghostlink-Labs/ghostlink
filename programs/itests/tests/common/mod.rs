//! Shared test harness: loads the compiled programs into LiteSVM, rebuilds
//! instructions from raw bytes (no program-crate dependency, so any drift
//! between the stacks fails loudly), and crafts token / oracle accounts.

use borsh::BorshSerialize;
use litesvm::LiteSVM;
use num_bigint::BigUint;
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signature::Signature;
use solana_signer::{Signer, SignerError};
use solana_transaction::Transaction;
use std::path::PathBuf;
use std::str::FromStr;

/// Minimal ed25519 signer for tests (see Cargo.toml for why this exists
/// instead of solana-keypair).
#[derive(Clone)]
pub struct Keypair {
    sk: ed25519_dalek::SigningKey,
}

impl Keypair {
    pub fn new_from_array(seed: [u8; 32]) -> Self {
        Keypair {
            sk: ed25519_dalek::SigningKey::from_bytes(&seed),
        }
    }

    pub fn new() -> Self {
        let mut seed = [0u8; 32];
        // Deterministic uniqueness is all tests need.
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        seed[..8].copy_from_slice(&n.to_le_bytes());
        seed[8..16].copy_from_slice(b"testkeyp");
        Keypair::new_from_array(sha(&[&seed]))
    }
}

impl Signer for Keypair {
    fn try_pubkey(&self) -> Result<Pubkey, SignerError> {
        Ok(Pubkey::new_from_array(self.sk.verifying_key().to_bytes()))
    }

    fn try_sign_message(&self, message: &[u8]) -> Result<Signature, SignerError> {
        use ed25519_dalek::Signer as _;
        Ok(Signature::from(self.sk.sign(message).to_bytes()))
    }

    fn is_interactive(&self) -> bool {
        false
    }
}

/// 64-byte signature over a message, for precompile payloads.
pub fn sign64(kp: &Keypair, message: &[u8]) -> [u8; 64] {
    use ed25519_dalek::Signer as _;
    kp.sk.sign(message).to_bytes()
}

pub const REGISTRY_ID: &str = "54EZ5ZkUANBs1SfQoXaU5EQSR8VAaD3XDtKEZGp6KjRv";
pub const CENSUS_ID: &str = "CvRA16GAa5ynUE3bzgMWuPYTbHLsdvyBydJoZVft5x9d";
pub const POCKET_ID: &str = "HbSux9YnTupzNiRUwdR2mjTpJJryx25RV42wry4kCwiH";
pub const TOKEN_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const ED25519_ID: &str = "Ed25519SigVerify111111111111111111111111111";
pub const SECP256R1_ID: &str = "Secp256r1SigVerify1111111111111111111111111";
pub const SYSVAR_IX_ID: &str = "Sysvar1nstructions1111111111111111111111111";
pub const SYSTEM_ID: &str = "11111111111111111111111111111111";
pub const PYTH_RECEIVER_ID: &str = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
/// Test-only program that forwards any instruction via CPI (programs/cpi-caller).
pub const CPI_CALLER_ID: &str = "GnAug2mhW6HavrtFSPWa3ikA4PmGibzBmUgk9Lq21tjk";
pub const PRICE_UPDATE_V2_DISC: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

pub fn pk(s: &str) -> Pubkey {
    Pubkey::from_str(s).unwrap()
}

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn load_json(rel: &str) -> Value {
    let path = repo_root().join(rel);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!("missing {rel}; run scripts/build-circuits.sh first")
    }))
    .unwrap()
}

pub fn vectors() -> Value {
    load_json("packages/common/fixtures/vectors.json")
}

/// Decimal field-element string -> 32 big-endian bytes.
pub fn fe(s: &str) -> [u8; 32] {
    let n = BigUint::parse_bytes(s.as_bytes(), 10).unwrap();
    let b = n.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}

pub fn hexv(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

pub fn hex32(s: &str) -> [u8; 32] {
    hexv(s).try_into().unwrap()
}

pub fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

pub fn label(name: &str) -> [u8; 32] {
    sha(&[format!("ghostlink vector: {name}").as_bytes()])
}

pub fn anchor_disc(name: &str) -> [u8; 8] {
    sha(&[format!("global:{name}").as_bytes()])[..8].try_into().unwrap()
}

/// snarkjs proof JSON -> (negated A, B, C) big-endian, groth16-solana shape.
pub fn convert_proof(proof: &Value) -> ([u8; 64], [u8; 128], [u8; 64]) {
    let fq = BigUint::parse_bytes(
        b"21888242871839275222246405745257275088696311157297823662689037894645226208583",
        10,
    )
    .unwrap();
    let dec = |v: &Value| BigUint::parse_bytes(v.as_str().unwrap().as_bytes(), 10).unwrap();
    let be32 = |n: &BigUint| -> [u8; 32] {
        let b = n.to_bytes_be();
        let mut out = [0u8; 32];
        out[32 - b.len()..].copy_from_slice(&b);
        out
    };
    let ay = dec(&proof["pi_a"][1]);
    let neg_ay = if ay == BigUint::from(0u8) { ay } else { &fq - (&ay % &fq) };
    let mut a = [0u8; 64];
    a[..32].copy_from_slice(&be32(&dec(&proof["pi_a"][0])));
    a[32..].copy_from_slice(&be32(&neg_ay));
    let mut b = [0u8; 128];
    b[..32].copy_from_slice(&be32(&dec(&proof["pi_b"][0][1])));
    b[32..64].copy_from_slice(&be32(&dec(&proof["pi_b"][0][0])));
    b[64..96].copy_from_slice(&be32(&dec(&proof["pi_b"][1][1])));
    b[96..].copy_from_slice(&be32(&dec(&proof["pi_b"][1][0])));
    let mut c = [0u8; 64];
    c[..32].copy_from_slice(&be32(&dec(&proof["pi_c"][0])));
    c[32..].copy_from_slice(&be32(&dec(&proof["pi_c"][1])));
    (a, b, c)
}

// ---- borsh mirrors of the pocket's argument types ----------------------

#[derive(BorshSerialize, Clone)]
pub struct OracleFeedBinding {
    pub mint: [u8; 32],
    pub feed_id: [u8; 32],
    pub decimals: u8,
}

#[derive(BorshSerialize, Clone)]
pub struct SpeculativePolicy {
    pub daily_buy_cap_usd_e6: u64,
    pub max_cost_exposure_usd_e6: u64,
    pub max_positions: u8,
    pub base_mints: Vec<[u8; 32]>,
}

#[derive(BorshSerialize, Clone)]
pub struct Policy {
    pub daily_cap_usd_e6: u64,
    pub max_slippage_bps: u16,
    pub big_action_threshold_usd_e6: u64,
    pub no_oracle_cap_usd_e6: u64,
    pub session_max_slots: u64,
    pub allowed_out_mints: Vec<[u8; 32]>,
    pub oracle_feeds: Vec<OracleFeedBinding>,
    pub speculative: Option<SpeculativePolicy>,
}

impl Policy {
    /// Canonical bytes exactly as programs/pocket/src/state.rs builds them.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = b"ghostlink:policy:v3".to_vec();
        out.extend_from_slice(&self.daily_cap_usd_e6.to_le_bytes());
        out.extend_from_slice(&self.max_slippage_bps.to_le_bytes());
        out.extend_from_slice(&self.big_action_threshold_usd_e6.to_le_bytes());
        out.extend_from_slice(&self.no_oracle_cap_usd_e6.to_le_bytes());
        out.extend_from_slice(&self.session_max_slots.to_le_bytes());
        out.push(self.allowed_out_mints.len() as u8);
        for m in &self.allowed_out_mints {
            out.extend_from_slice(m);
        }
        out.push(self.oracle_feeds.len() as u8);
        for f in &self.oracle_feeds {
            out.extend_from_slice(&f.mint);
            out.extend_from_slice(&f.feed_id);
            out.push(f.decimals);
        }
        out.push(u8::from(self.speculative.is_some()));
        if let Some(s) = &self.speculative {
            out.extend_from_slice(&s.daily_buy_cap_usd_e6.to_le_bytes());
            out.extend_from_slice(&s.max_cost_exposure_usd_e6.to_le_bytes());
            out.push(s.max_positions);
            out.push(s.base_mints.len() as u8);
            for m in &s.base_mints { out.extend_from_slice(m); }
        }
        out
    }

    pub fn hash(&self) -> [u8; 32] {
        sha(&[&self.canonical_bytes()])
    }
}

/// The fixtures' feeds policy: conservative defaults plus the two pinned
/// oracle feeds (matches vectors.policyWithFeeds, asserted in tests).
pub fn feeds_policy() -> Policy {
    Policy {
        daily_cap_usd_e6: 200_000_000,
        max_slippage_bps: 100,
        big_action_threshold_usd_e6: 50_000_000,
        no_oracle_cap_usd_e6: 20_000_000,
        session_max_slots: 216_000,
        allowed_out_mints: vec![],
        speculative: None,
        oracle_feeds: vec![
            OracleFeedBinding {
                mint: label("usdc mint"),
                feed_id: label("usdc pyth feed"),
                decimals: 6,
            },
            OracleFeedBinding {
                mint: label("sol mint"),
                feed_id: label("sol pyth feed"),
                decimals: 9,
            },
        ],
    }
}

pub fn speculative_policy() -> Policy {
    let mut p = feeds_policy();
    p.speculative = Some(SpeculativePolicy { daily_buy_cap_usd_e6: 30_000_000,
        max_cost_exposure_usd_e6: 20_000_000, max_positions: 2,
        base_mints: vec![label("usdc mint"), label("sol mint")] });
    p
}

#[derive(BorshSerialize, Clone)]
pub struct OpenSessionArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub registry_root: [u8; 32],
    pub census_root: [u8; 32],
    pub domain_hash: [u8; 32],
    pub app_id: [u8; 32],
    pub mint: [u8; 32],
    pub threshold: u64,
    pub min_slot: u64,
    pub claim_holdings: bool,
    pub session_kind: u8,
    pub session_key: [u8; 33],
    pub session_expiry_slot: u64,
    pub home: [u8; 32],
    pub policy: Option<Policy>,
}

#[derive(BorshSerialize, Clone)]
pub struct IntentArgs {
    pub nonce: u64,
    pub in_mint: [u8; 32],
    pub in_max: u64,
    pub out_mint: [u8; 32],
    pub out_min: u64,
    pub deadline_slot: u64,
    pub policy_hash: [u8; 32],
}

#[derive(BorshSerialize, Clone)]
pub struct WebauthnData {
    pub authenticator_data: Vec<u8>,
    pub client_data_json: Vec<u8>,
}

#[derive(BorshSerialize, Clone)]
pub struct OwnerProofArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub registry_root: [u8; 32],
}

#[derive(BorshSerialize, Clone)]
pub enum SessionOrOwner {
    Session { webauthn: Option<WebauthnData> },
    Owner(OwnerProofArgs),
}

#[derive(BorshSerialize, Clone)]
pub enum Change {
    Home([u8; 32]),
    Policy(Policy),
}

pub fn ix_data<T: BorshSerialize>(name: &str, args: &T) -> Vec<u8> {
    let mut data = anchor_disc(name).to_vec();
    args.serialize(&mut data).unwrap();
    data
}

// ---- precompile instruction builders ------------------------------------

/// Ed25519 precompile verifying one signature, all offsets inside itself.
pub fn ed25519_ix(pubkey: &[u8; 32], signature: &[u8; 64], message: &[u8]) -> Instruction {
    build_sig_ix(pk(ED25519_ID), pubkey, signature, message)
}

/// secp256r1 precompile: same layout, 33-byte compressed key.
pub fn secp256r1_ix(pubkey33: &[u8; 33], signature: &[u8; 64], message: &[u8]) -> Instruction {
    build_sig_ix_raw(pk(SECP256R1_ID), pubkey33, signature, message)
}

fn build_sig_ix(program: Pubkey, pubkey: &[u8; 32], sig: &[u8; 64], msg: &[u8]) -> Instruction {
    build_sig_ix_raw(program, pubkey, sig, msg)
}

fn build_sig_ix_raw(program: Pubkey, pubkey: &[u8], sig: &[u8; 64], msg: &[u8]) -> Instruction {
    // count u8 | padding u8 | sig_off u16 | sig_ix u16 | pk_off u16 |
    // pk_ix u16 | msg_off u16 | msg_len u16 | msg_ix u16 | payload...
    let header = 2 + 14;
    let pk_off = header;
    let sig_off = pk_off + pubkey.len();
    let msg_off = sig_off + 64;
    let mut data = Vec::with_capacity(msg_off + msg.len());
    data.push(1);
    data.push(0);
    for v in [
        sig_off as u16,
        u16::MAX,
        pk_off as u16,
        u16::MAX,
        msg_off as u16,
        msg.len() as u16,
        u16::MAX,
    ] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    data.extend_from_slice(pubkey);
    data.extend_from_slice(sig);
    data.extend_from_slice(msg);
    Instruction {
        program_id: program,
        accounts: vec![],
        data,
    }
}

// ---- account crafting ----------------------------------------------------

/// A raw SPL token account (165 bytes) owned by the SPL Token program.
pub fn token_account(mint: &[u8; 32], owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint);
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // initialized
    Account {
        lamports: 2_039_280,
        data,
        owner: pk(TOKEN_ID),
        executable: false,
        rent_epoch: 0,
    }
}

/// A Pyth PriceUpdateV2 account with a fully-verified price.
pub fn pyth_account(feed_id: &[u8; 32], price: i64, exponent: i32, publish_time: i64) -> Account {
    let mut data = Vec::with_capacity(134);
    data.extend_from_slice(&PRICE_UPDATE_V2_DISC);
    data.extend_from_slice(&[0u8; 32]); // write authority
    data.push(1); // VerificationLevel::Full
    data.extend_from_slice(&[0u8; 32][..0]); // (no partial byte)
    data.extend_from_slice(feed_id);
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // conf
    data.extend_from_slice(&exponent.to_le_bytes());
    data.extend_from_slice(&publish_time.to_le_bytes());
    data.extend_from_slice(&publish_time.to_le_bytes()); // prev
    data.extend_from_slice(&price.to_le_bytes()); // ema price
    data.extend_from_slice(&0u64.to_le_bytes()); // ema conf
    data.extend_from_slice(&0u64.to_le_bytes()); // posted slot
    Account {
        lamports: 10_000_000,
        data,
        owner: pk(PYTH_RECEIVER_ID),
        executable: false,
        rent_epoch: 0,
    }
}

/// SetComputeUnitLimit: proof-bearing transactions request 400k CU
/// (build plan, section 6 compute budget).
pub fn compute_budget(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: pk("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

/// SPL Token Transfer instruction (solver's own transfer, normal signer).
pub fn spl_transfer(source: &Pubkey, dest: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: pk(TOKEN_ID),
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// Creates a real token-program-owned account, before its SPL initializer.
pub fn create_token_account(payer: &Pubkey, address: &Pubkey, space: u64, lamports: u64) -> Instruction {
    let mut data = 0u32.to_le_bytes().to_vec(); // SystemInstruction::CreateAccount
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(pk(TOKEN_ID).as_ref());
    Instruction {
        program_id: pk(SYSTEM_ID),
        accounts: vec![AccountMeta::new(*payer, true), AccountMeta::new(*address, true)],
        data,
    }
}

// ---- harness ---------------------------------------------------------------

pub struct Harness {
    pub svm: LiteSVM,
    pub payer: Keypair,
}

impl Harness {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new().with_precompiles();
        let deploy_dir = std::env::var("CARGO_TARGET_DIR")
            .map(|d| PathBuf::from(d).join("deploy"))
            .unwrap_or_else(|_| repo_root().join("target/deploy"));
        for (id, so) in [
            (REGISTRY_ID, "ghostlink_registry.so"),
            (CENSUS_ID, "ghostlink_census.so"),
            (POCKET_ID, "ghostlink_pocket.so"),
            (CPI_CALLER_ID, "ghostlink_cpi_caller.so"),
        ] {
            svm.add_program_from_file(pk(id), deploy_dir.join(so))
                .unwrap_or_else(|e| panic!("load {so}: {e:?}"));
        }
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        Harness { svm, payer }
    }

    pub fn send(
        &mut self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<(), String> {
        // Fresh blockhash per send: deliberately re-sent byte-identical
        // transactions (nonce-reuse tests etc.) must not be deduped.
        self.svm.expire_blockhash();
        let payer_pk = self.payer.pubkey();
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend_from_slice(signers);
        let msg = Message::new(instructions, Some(&payer_pk));
        let tx = Transaction::new(&all, msg, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|f| format!("{:?}", f.err))
    }

    /// Send and demand failure, returning the error debug string.
    pub fn send_expect_err(&mut self, instructions: &[Instruction], signers: &[&Keypair]) -> String {
        match self.send(instructions, signers) {
            Ok(()) => panic!("transaction unexpectedly succeeded"),
            Err(e) => e,
        }
    }

    pub fn account_data(&self, address: &Pubkey) -> Option<Vec<u8>> {
        self.svm.get_account(address).map(|a| a.data)
    }

    pub fn token_balance(&self, address: &Pubkey) -> Option<u64> {
        self.account_data(address)
            .filter(|d| d.len() >= 72)
            .map(|d| u64::from_le_bytes(d[64..72].try_into().unwrap()))
    }
}

/// Wraps `inner` so the CPI caller program's `forward` invokes it: the
/// target program is the one named account, the original accounts follow
/// as remaining accounts (signer flags carry through), and the original
/// data travels as the borsh `Vec<u8>` argument.
pub fn via_cpi(inner: Instruction) -> Instruction {
    let mut accounts = vec![meta_r(inner.program_id)];
    accounts.extend(inner.accounts);
    Instruction {
        program_id: pk(CPI_CALLER_ID),
        accounts,
        data: ix_data("forward", &inner.data),
    }
}

pub fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

pub fn meta_w(p: Pubkey) -> AccountMeta {
    AccountMeta::new(p, false)
}

pub fn meta_r(p: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(p, false)
}
