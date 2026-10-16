//! End-to-end program tests under LiteSVM (build plan, test layers 3–4):
//! the compiled registry, census and pocket binaries running the real
//! flows — registration with precompile introspection, census snapshots,
//! proof-verified session opening, atomic intent fills with oracle
//! floors, sweeps, timelocked changes and revocation — plus the refusal
//! cases the threat model demands.
//!
//! The fixtures replay exactly: one registration and one snapshot
//! reproduce the fixture Merkle roots, so the committed proofs verify
//! on-chain unchanged.

mod common;
#[path = "common/speculative_flows.rs"]
mod speculative_flows;

use common::*;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_signer::Signer;

const SNAPSHOT_SLOT: u64 = 123_456_789;
const OPEN_SLOT: u64 = 123_456_790;
const FILL_SLOT: u64 = 123_456_800;
const EXPIRY_SLOT: u64 = 123_500_000;
const UNIX_T: i64 = 1_800_000_000;
const TIMELOCK_SLOTS: u64 = 216_000;

fn set_clock(h: &mut Harness, slot: u64) {
    let clock = Clock {
        slot,
        epoch_start_timestamp: UNIX_T,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: UNIX_T,
    };
    h.svm.set_sysvar::<Clock>(&clock);
}

struct Ctx {
    h: Harness,
    v: serde_json::Value,
    wallet: Keypair,
    session: Keypair,
    registry_tree: Pubkey,
    census_tree: Pubkey,
    pocket: Pubkey,
    home: Pubkey,
    usdc: [u8; 32],
    sol: [u8; 32],
    policy: Policy,
}

fn keypair_from_seed(seed: &[u8; 32]) -> Keypair {
    Keypair::new_from_array(*seed)
}

fn registration_message(v: &serde_json::Value) -> Vec<u8> {
    let commitment_hex: String = fe(v["identity"]["commitment"].as_str().unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!(
        "ghostlink:register:v1\ncommitment:{commitment_hex}\nwallet:{}\nprogram:{}\ncluster:devnet",
        v["identity"]["walletBase58"].as_str().unwrap(),
        REGISTRY_ID,
    )
    .into_bytes()
}

fn setup() -> Ctx {
    let mut h = Harness::new();
    let v = vectors();
    let wallet = keypair_from_seed(&hex32(v["identity"]["walletSeed"].as_str().unwrap()));
    let session = keypair_from_seed(&hex32(v["identity"]["sessionSeed"].as_str().unwrap()));
    assert_eq!(
        wallet.pubkey().to_bytes(),
        hex32(v["identity"]["walletPubkey"].as_str().unwrap()),
        "wallet keypair must match the fixture public key"
    );

    let registry_tree = pda(&[b"tree"], &pk(REGISTRY_ID));
    let census_tree = pda(&[b"census"], &pk(CENSUS_ID));
    let app_id = fe(v["identity"]["appId"].as_str().unwrap());
    let pocket = pda(&[b"pocket", &app_id], &pk(POCKET_ID));
    assert_eq!(
        pocket.to_string(),
        v["pdas"]["pocket"]["address"].as_str().unwrap(),
        "pocket PDA must match the fixture"
    );
    let home = Pubkey::new_from_array(hex32(v["identity"]["homeAddress"].as_str().unwrap()));

    let policy = feeds_policy();
    assert_eq!(
        policy.hash().iter().map(|b| format!("{b:02x}")).collect::<String>(),
        v["policyWithFeeds"]["hash"].as_str().unwrap(),
        "Rust policy bytes must match the TypeScript fixture"
    );

    set_clock(&mut h, SNAPSHOT_SLOT - 100);

    // initialize both trees
    let init_reg = Instruction {
        program_id: pk(REGISTRY_ID),
        accounts: vec![
            AccountMeta::new(h.payer.pubkey(), true),
            meta_w(registry_tree),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("initialize", &()),
    };
    let init_cen = Instruction {
        program_id: pk(CENSUS_ID),
        accounts: vec![
            AccountMeta::new(h.payer.pubkey(), true),
            meta_w(census_tree),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("initialize", &()),
    };
    h.send(&[init_reg, init_cen], &[]).expect("initialize trees");

    Ctx {
        h,
        v,
        wallet,
        session,
        registry_tree,
        census_tree,
        pocket,
        home,
        usdc: label("usdc mint"),
        sol: label("sol mint"),
        policy,
    }
}

fn register_ix(ctx: &Ctx) -> Instruction {
    let binding = pda(&[b"binding", ctx.wallet.pubkey().as_ref()], &pk(REGISTRY_ID));
    Instruction {
        program_id: pk(REGISTRY_ID),
        accounts: vec![
            AccountMeta::new(ctx.h.payer.pubkey(), true),
            meta_r(ctx.wallet.pubkey()),
            meta_w(binding),
            meta_w(ctx.registry_tree),
            meta_r(pk(SYSVAR_IX_ID)),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("register", &fe(ctx.v["identity"]["commitment"].as_str().unwrap())),
    }
}

fn register(ctx: &mut Ctx) {
    let msg = registration_message(&ctx.v);
    let sig = sign64(&ctx.wallet, &msg);
    let pre = ed25519_ix(&ctx.wallet.pubkey().to_bytes(), &sig, &msg);
    let reg = register_ix(ctx);
    ctx.h.send(&[pre, reg], &[]).expect("register");

    // The on-chain root must now equal the fixture circuit root.
    let data = ctx.h.account_data(&ctx.registry_tree).unwrap();
    let root = fe(ctx.v["circuits"]["login"]["public"]["registry_root"].as_str().unwrap());
    assert!(
        ghostlink_verifier::merkle::tree_account::ring_contains(&data, &root),
        "registry ring must contain the fixture root"
    );
}

fn snapshot(ctx: &mut Ctx) {
    set_clock(&mut ctx.h, SNAPSHOT_SLOT);
    let holding = Pubkey::new_unique();
    ctx.h.svm.set_account(
        holding,
        token_account(&ctx.usdc, &ctx.wallet.pubkey(), 150_000_000),
    )
    .unwrap();
    let ix = Instruction {
        program_id: pk(CENSUS_ID),
        accounts: vec![
            AccountMeta::new(ctx.h.payer.pubkey(), true),
            meta_r(ctx.wallet.pubkey()),
            meta_r(holding),
            meta_w(ctx.census_tree),
        ],
        data: ix_data("snapshot", &()),
    };
    ctx.h.send(&[ix], &[]).expect("snapshot");

    let data = ctx.h.account_data(&ctx.census_tree).unwrap();
    let root = fe(ctx.v["circuits"]["login"]["public"]["census_root"].as_str().unwrap());
    assert!(
        ghostlink_verifier::merkle::tree_account::ring_contains(&data, &root),
        "census ring must contain the fixture root"
    );
}

fn open_session_args(ctx: &Ctx, proof_file: &str, kind: u8, key33: [u8; 33], with_policy: bool) -> OpenSessionArgs {
    let fx = load_json(proof_file);
    let (a, b, c) = convert_proof(&fx["proof"]);
    let pubs = &ctx.v["circuits"]["login"]["public"];
    OpenSessionArgs {
        proof_a: a,
        proof_b: b,
        proof_c: c,
        registry_root: fe(pubs["registry_root"].as_str().unwrap()),
        census_root: fe(pubs["census_root"].as_str().unwrap()),
        domain_hash: fe(pubs["domain_hash"].as_str().unwrap()),
        app_id: fe(pubs["app_id"].as_str().unwrap()),
        mint: ctx.usdc,
        threshold: 100_000_000,
        min_slot: 123_450_000,
        claim_holdings: true,
        session_kind: kind,
        session_key: key33,
        session_expiry_slot: EXPIRY_SLOT,
        home: ctx.home.to_bytes(),
        policy: if with_policy { Some(ctx.policy.clone()) } else { None },
    }
}

fn open_session_ix(ctx: &Ctx, args: &OpenSessionArgs) -> Instruction {
    Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new(ctx.h.payer.pubkey(), true),
            meta_w(ctx.pocket),
            meta_r(ctx.registry_tree),
            meta_r(ctx.census_tree),
            meta_r(pk(SYSVAR_IX_ID)),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("open_session_v2", args),
    }
}

fn ed25519_key33(session: &Keypair) -> [u8; 33] {
    let mut key = [0u8; 33];
    key[..32].copy_from_slice(&session.pubkey().to_bytes());
    key
}

#[test]
fn identity_flow_and_refusals() {
    let mut ctx = setup();

    // A signature over the wrong message is refused.
    let wrong_msg = b"something else entirely".to_vec();
    let sig = sign64(&ctx.wallet, &wrong_msg);
    let pre = ed25519_ix(&ctx.wallet.pubkey().to_bytes(), &sig, &wrong_msg);
    let err = ctx.h.send_expect_err(&[pre, register_ix(&ctx)], &[]);
    assert!(err.contains("Custom(6005)") || err.contains("WrongMessage"), "{err}");

    // Registration without any precompile is refused.
    let err = ctx.h.send_expect_err(&[register_ix(&ctx)], &[]);
    assert!(err.contains("Custom(6002)") || err.contains("MissingSignature"), "{err}");

    register(&mut ctx);

    // One binding per wallet: a second registration is refused.
    let msg = registration_message(&ctx.v);
    let sig = sign64(&ctx.wallet, &msg);
    let pre = ed25519_ix(&ctx.wallet.pubkey().to_bytes(), &sig, &msg);
    let err = ctx.h.send_expect_err(&[pre, register_ix(&ctx)], &[]);
    // Anchor's init CPI hits the system program's AccountAlreadyInUse.
    assert!(err.contains("already in use") || err.contains("Custom(0)"), "{err}");

    snapshot(&mut ctx);

    // Open a session with the fixture proof.
    set_clock(&mut ctx.h, OPEN_SLOT);
    let proof = "circuits/keys/login_proof.json";
    let args = open_session_args(&ctx, proof, 0, ed25519_key33(&ctx.session), true);
    ctx.h.send(&[compute_budget(400_000), open_session_ix(&ctx, &args)], &[]).expect("open_session");

    let data = ctx.h.account_data(&ctx.pocket).expect("pocket exists");
    assert_eq!(&data[8..40], &args.app_id, "stored app_id");
    assert_eq!(&data[72..104], ctx.home.as_ref(), "stored home");

    // The same proof with a different session key must fail: the proof
    // bound the original session commitment.
    let mallory = Keypair::new();
    let mut bad = args.clone();
    bad.session_key = ed25519_key33(&mallory);
    let err = ctx.h.send_expect_err(&[compute_budget(400_000), open_session_ix(&ctx, &bad)], &[]);
    assert!(err.contains("ProofInvalid") || err.contains("Custom(6002)"), "{err}");

    // A rotten registry root (not in the ring) must fail.
    let mut bad = args.clone();
    bad.registry_root = fe("12345");
    let err = ctx.h.send_expect_err(&[compute_budget(400_000), open_session_ix(&ctx, &bad)], &[]);
    assert!(err.contains("UnknownRegistryRoot") || err.contains("Custom(6003)"), "{err}");
}

// ---- fills ---------------------------------------------------------------

#[test]
fn first_session_binds_policy_purpose_and_deployment() {
    let mut ctx = setup();
    register(&mut ctx);
    snapshot(&mut ctx);
    set_clock(&mut ctx.h, OPEN_SLOT);
    let args = open_session_args(&ctx, "circuits/keys/login_proof.json", 0, ed25519_key33(&ctx.session), true);

    // A captured proof must not let its submitter change any policy field.
    for i in 0..9 {
        let mut bad = args.clone();
        let p = bad.policy.as_mut().unwrap();
        match i {
            0 => p.daily_cap_usd_e6 += 1,
            1 => p.max_slippage_bps += 1,
            2 => p.big_action_threshold_usd_e6 += 1,
            3 => p.no_oracle_cap_usd_e6 += 1,
            4 => p.session_max_slots += 1,
            5 => p.allowed_out_mints.push(ctx.sol),
            6 => p.oracle_feeds[0].mint = label("different priced mint"),
            7 => p.oracle_feeds[0].feed_id[0] ^= 1,
            _ => p.oracle_feeds[0].decimals += 1,
        }
        let err = ctx.h.send_expect_err(&[compute_budget(400_000), open_session_ix(&ctx, &bad)], &[]);
        assert!(err.contains("ProofInvalid") || err.contains("Custom(6002)"), "policy field {i}: {err}");
        assert!(ctx.h.account_data(&ctx.pocket).is_none(), "failed creation must roll back");
    }
    for name in ["login_offchain", "login_other_deployment"] {
        let bad = open_session_args(&ctx, &format!("circuits/keys/{name}_proof.json"), 0, ed25519_key33(&ctx.session), true);
        let err = ctx.h.send_expect_err(&[compute_budget(400_000), open_session_ix(&ctx, &bad)], &[]);
        assert!(err.contains("ProofInvalid") || err.contains("Custom(6002)"), "{name}: {err}");
    }
    for change_home in [true, false] {
        let mut bad = args.clone();
        if change_home { bad.home[0] ^= 1; } else { bad.domain_hash = fe("123"); }
        let err = ctx.h.send_expect_err(&[compute_budget(400_000), open_session_ix(&ctx, &bad)], &[]);
        assert!(err.contains("ProofInvalid") || err.contains("Custom(6002)"), "{err}");
    }
    // V1 dispatch is absent: no fallback may bypass the new proof contract.
    let mut legacy = open_session_ix(&ctx, &args);
    legacy.data = ix_data("open_session", &args);
    let err = ctx.h.send_expect_err(&[compute_budget(400_000), legacy], &[]);
    assert!(err.contains("InstructionFallbackNotFound") || err.contains("Custom(101)"), "{err}");

    ctx.h.send(&[compute_budget(400_000), open_session_ix(&ctx, &args)], &[]).expect("approved V2 policy opens");
}

struct FillWorld {
    ctx: Ctx,
    solver: Keypair,
    pocket_in: Pubkey,
    solver_in: Pubkey,
    pocket_out: Pubkey,
    solver_out: Pubkey,
    usdc_price: Pubkey,
    sol_price: Pubkey,
}

fn fill_world() -> FillWorld { fill_world_with_policy(false) }

fn fill_world_with_policy(speculative: bool) -> FillWorld {
    let mut ctx = setup();
    if speculative { ctx.policy = speculative_policy(); }
    register(&mut ctx);
    snapshot(&mut ctx);
    set_clock(&mut ctx.h, OPEN_SLOT);
    let proof = if speculative { "circuits/keys/login_speculative_proof.json" } else { "circuits/keys/login_proof.json" };
    let args = open_session_args(&ctx, proof, 0, ed25519_key33(&ctx.session), true);
    ctx.h.send(&[compute_budget(400_000), open_session_ix(&ctx, &args)], &[]).expect("open_session");
    set_clock(&mut ctx.h, FILL_SLOT);

    let solver = Keypair::new();
    ctx.h.svm.airdrop(&solver.pubkey(), 10_000_000_000).unwrap();

    let pocket_in = Pubkey::new_unique();
    let solver_in = Pubkey::new_unique();
    let pocket_out = Pubkey::new_unique();
    let solver_out = Pubkey::new_unique();
    let usdc_price = Pubkey::new_unique();
    let sol_price = Pubkey::new_unique();
    let usdc = ctx.usdc;
    let sol = ctx.sol;
    let pocket = ctx.pocket;
    let sp = solver.pubkey();
    let svm = &mut ctx.h.svm;
    svm.set_account(pocket_in, token_account(&usdc, &pocket, 25_000_000)).unwrap();
    svm.set_account(solver_in, token_account(&usdc, &sp, 0)).unwrap();
    svm.set_account(pocket_out, token_account(&sol, &pocket, 0)).unwrap();
    svm.set_account(solver_out, token_account(&sol, &sp, 1_000_000_000)).unwrap();
    // USDC at $1.00 and SOL at $156.25, both with exponent -8.
    svm.set_account(usdc_price, pyth_account(&label("usdc pyth feed"), 100_000_000, -8, UNIX_T)).unwrap();
    svm.set_account(sol_price, pyth_account(&label("sol pyth feed"), 15_625_000_000, -8, UNIX_T)).unwrap();

    FillWorld { ctx, solver, pocket_in, solver_in, pocket_out, solver_out, usdc_price, sol_price }
}

fn fixture_intent(w: &FillWorld) -> IntentArgs {
    IntentArgs {
        nonce: 7,
        in_mint: w.ctx.usdc,
        in_max: 25_000_000,
        out_mint: w.ctx.sol,
        out_min: 160_000_000,
        deadline_slot: 123_456_900,
        policy_hash: w.ctx.policy.hash(),
    }
}

fn intent_hash_of(w: &FillWorld, args: &IntentArgs) -> [u8; 32] {
    let intent = ghostlink_verifier::intent::Intent {
        pocket: w.ctx.pocket.to_bytes(),
        nonce: args.nonce,
        in_mint: args.in_mint,
        in_max: args.in_max,
        out_mint: args.out_mint,
        out_min: args.out_min,
        deadline_slot: args.deadline_slot,
        policy_hash: args.policy_hash,
    };
    sha(&[&intent.to_bytes()])
}

fn fill_begin_ix(w: &FillWorld, args: &IntentArgs, in_price: &Pubkey, webauthn: Option<WebauthnData>) -> Instruction {
    #[derive(borsh::BorshSerialize)]
    struct BeginArgs(IntentArgs, Option<WebauthnData>);
    let fill_state = pda(
        &[b"fill", w.ctx.pocket.as_ref(), &args.nonce.to_le_bytes()],
        &pk(POCKET_ID),
    );
    Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new(w.solver.pubkey(), true),
            meta_w(w.ctx.pocket),
            meta_w(w.pocket_in),
            meta_w(w.solver_in),
            meta_r(w.pocket_out),
            meta_r(*in_price),
            meta_w(fill_state),
            meta_r(pk(TOKEN_ID)),
            meta_r(pk(SYSVAR_IX_ID)),
            meta_r(pk(SYSTEM_ID)),
        ],
        data: ix_data("fill_begin", &BeginArgs(args.clone(), webauthn)),
    }
}

fn fill_end_ix(w: &FillWorld, args: &IntentArgs, pocket_out: &Pubkey, out_price: Option<&Pubkey>) -> Instruction {
    let fill_state = pda(
        &[b"fill", w.ctx.pocket.as_ref(), &args.nonce.to_le_bytes()],
        &pk(POCKET_ID),
    );
    Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new(w.solver.pubkey(), true),
            meta_w(w.ctx.pocket),
            meta_w(fill_state),
            meta_r(*pocket_out),
            // Anchor optional account: the program id itself means None.
            meta_r(out_price.copied().unwrap_or_else(|| pk(POCKET_ID))),
        ],
        data: ix_data("fill_end", args),
    }
}

fn session_sig_ix(w: &FillWorld, digest: &[u8; 32]) -> Instruction {
    let sig = sign64(&w.ctx.session, digest);
    ed25519_ix(&w.ctx.session.pubkey().to_bytes(), &sig, digest)
}

#[test]
fn fill_flow_and_refusals() {
    let mut w = fill_world();

    // Happy path: sign, begin, route (a plain transfer), end.
    let args = fixture_intent(&w);
    let digest = intent_hash_of(&w, &args);
    let solver_pk = w.solver.pubkey();
    let txi = vec![
        session_sig_ix(&w, &digest),
        fill_begin_ix(&w, &args, &w.usdc_price.clone(), None),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 165_000_000),
        fill_end_ix(&w, &args, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
    ];
    let solver = w.solver.clone();
    w.ctx.h.send(&txi, &[&solver]).expect("happy fill");
    assert_eq!(w.ctx.h.token_balance(&w.solver_in), Some(25_000_000));
    assert_eq!(w.ctx.h.token_balance(&w.pocket_out), Some(165_000_000));
    assert_eq!(w.ctx.h.token_balance(&w.pocket_in), Some(0));

    // Nonce reuse is refused.
    let txi = vec![
        session_sig_ix(&w, &digest),
        fill_begin_ix(&w, &args, &w.usdc_price.clone(), None),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 165_000_000),
        fill_end_ix(&w, &args, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6016)") || err.contains("NonceUsed"), "{err}");

    // Refill the pocket's input account for the failure cases.
    let refill = token_account(&w.ctx.usdc, &w.ctx.pocket, 25_000_000);
    w.ctx.h.svm.set_account(w.pocket_in, refill).unwrap();

    // Underfill: solver delivers less than out_min -> the WHOLE
    // transaction reverts and the pocket keeps its input (atomicity).
    let mut under = fixture_intent(&w);
    under.nonce = 8;
    let digest8 = intent_hash_of(&w, &under);
    let txi = vec![
        session_sig_ix(&w, &digest8),
        fill_begin_ix(&w, &under, &w.usdc_price.clone(), None),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 150_000_000),
        fill_end_ix(&w, &under, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6029)") || err.contains("OutputTooLow"), "{err}");
    assert_eq!(
        w.ctx.h.token_balance(&w.pocket_in),
        Some(25_000_000),
        "atomic revert must keep the input in the pocket"
    );

    // Slippage floor: an out_min far below oracle parity is refused even
    // when the solver delivers it.
    let mut cheap = fixture_intent(&w);
    cheap.nonce = 9;
    cheap.out_min = 100_000_000; // $15.63 against $25 in
    let digest9 = intent_hash_of(&w, &cheap);
    let txi = vec![
        session_sig_ix(&w, &digest9),
        fill_begin_ix(&w, &cheap, &w.usdc_price.clone(), None),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 100_000_000),
        fill_end_ix(&w, &cheap, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6030)") || err.contains("SlippageFloor"), "{err}");

    // fill_begin with no fill_end anywhere is refused.
    let mut lone = fixture_intent(&w);
    lone.nonce = 10;
    let digest10 = intent_hash_of(&w, &lone);
    let txi = vec![
        session_sig_ix(&w, &digest10),
        fill_begin_ix(&w, &lone, &w.usdc_price.clone(), None),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6022)") || err.contains("NoFillEnd"), "{err}");

    // Two interleaved begins are refused.
    let mut second = fixture_intent(&w);
    second.nonce = 11;
    let digest11 = intent_hash_of(&w, &second);
    let txi = vec![
        session_sig_ix(&w, &digest10),
        fill_begin_ix(&w, &lone, &w.usdc_price.clone(), None),
        session_sig_ix(&w, &digest11),
        fill_begin_ix(&w, &second, &w.usdc_price.clone(), None),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 165_000_000),
        fill_end_ix(&w, &second, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
        fill_end_ix(&w, &lone, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6023)") || err.contains("FillInterleaved"), "{err}");

    // A software session may not exceed the big-action threshold.
    let mut big = fixture_intent(&w);
    big.nonce = 12;
    big.in_max = 60_000_000; // $60 > $50 threshold
    let digest12 = intent_hash_of(&w, &big);
    let txi = vec![
        session_sig_ix(&w, &digest12),
        fill_begin_ix(&w, &big, &w.usdc_price.clone(), None),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 400_000_000),
        fill_end_ix(&w, &big, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6028)") || err.contains("PasskeyRequired"), "{err}");

    // A software session may not buy a mint without an oracle feed.
    let nft = label("nft mint");
    let pocket_nft = Pubkey::new_unique();
    w.ctx.h.svm.set_account(pocket_nft, token_account(&nft, &w.ctx.pocket, 0)).unwrap();
    let mut noracle = fixture_intent(&w);
    noracle.nonce = 13;
    noracle.in_max = 10_000_000;
    noracle.out_mint = nft;
    noracle.out_min = 1;
    let digest13 = intent_hash_of(&w, &noracle);
    let solver_nft = Pubkey::new_unique();
    w.ctx.h.svm.set_account(solver_nft, token_account(&nft, &solver_pk, 5)).unwrap();
    let saved_out = w.pocket_out;
    let priced_output = w.pocket_out;
    w.pocket_out = pocket_nft;
    // Include a matching fill_end so the begin/end pairing check passes
    // and the refusal is specifically the no-oracle policy.
    let txi = vec![
        session_sig_ix(&w, &digest13),
        fill_begin_ix(&w, &noracle, &w.usdc_price.clone(), None),
        spl_transfer(&solver_nft, &pocket_nft, &solver_pk, 1),
        fill_end_ix(&w, &noracle, &pocket_nft, None),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6027)") || err.contains("NoOracleViolation"), "{err}");
    w.pocket_out = saved_out;

    // A signature by the wrong key is refused.
    let mut alien = fixture_intent(&w);
    alien.nonce = 14;
    let digest14 = intent_hash_of(&w, &alien);
    let sig = sign64(&w.ctx.wallet, &digest14);
    let bad_pre = ed25519_ix(&w.ctx.wallet.pubkey().to_bytes(), &sig, &digest14);
    let txi = vec![
        bad_pre,
        fill_begin_ix(&w, &alien, &w.usdc_price.clone(), None),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 165_000_000),
        fill_end_ix(&w, &alien, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6019)") || err.contains("WrongSigner"), "{err}");

    // Fake delivery: anyone can create a second token account owned by
    // the pocket. A solver that pre-seeds one with out_min of the output
    // mint and hands fill_end THAT account would see its standing balance
    // as the "delta" — and take the input for nothing, every fill, until
    // the daily cap. fill_end must measure the account fill_begin
    // snapshotted and no other.
    let aux_out = Pubkey::new_unique();
    w.ctx.h.svm.set_account(aux_out, token_account(&w.ctx.sol, &w.ctx.pocket, 200_000_000)).unwrap();
    let mut fake = fixture_intent(&w);
    fake.nonce = 15;
    let digest15 = intent_hash_of(&w, &fake);
    let txi = vec![
        session_sig_ix(&w, &digest15),
        fill_begin_ix(&w, &fake, &w.usdc_price.clone(), None),
        fill_end_ix(&w, &fake, &aux_out, Some(&w.sol_price.clone())),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6040)") || err.contains("FillAccountMismatch"), "{err}");
    assert_eq!(w.ctx.h.token_balance(&w.pocket_in), Some(25_000_000), "nothing left the pocket");
}

#[test]
fn nonce_window_slides() {
    let mut w = fill_world();
    let solver = w.solver.clone();
    let solver_pk = solver.pubkey();
    let fill = |w: &mut FillWorld, nonce: u64| -> Result<(), String> {
        let mut args = fixture_intent(w);
        args.nonce = nonce;
        let digest = intent_hash_of(w, &args);
        let txi = vec![
            session_sig_ix(w, &digest),
            fill_begin_ix(w, &args, &w.usdc_price.clone(), None),
            spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 165_000_000),
            fill_end_ix(w, &args, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
        ];
        w.ctx.h.send(&txi, &[&solver])
    };
    let refill = |w: &mut FillWorld| {
        let acct = token_account(&w.ctx.usdc, &w.ctx.pocket, 25_000_000);
        w.ctx.h.svm.set_account(w.pocket_in, acct).unwrap();
    };

    fill(&mut w, 7).expect("nonce 7");
    // A nonce far beyond the 2048-wide window slides it forward instead
    // of being refused: a counter can run for the pocket's whole life.
    refill(&mut w);
    fill(&mut w, 5000).expect("nonce 5000 slides the window");
    // Values that fell out of the window read as used — including ones
    // that were never used, so an old signed intent can never resurface.
    refill(&mut w);
    let err = fill(&mut w, 7).unwrap_err();
    assert!(err.contains("Custom(6016)") || err.contains("NonceUsed"), "{err}");
    let err = fill(&mut w, 2952).unwrap_err();
    assert!(err.contains("Custom(6016)") || err.contains("NonceUsed"), "{err}");
    // The oldest value still inside the window is fine.
    fill(&mut w, 2953).expect("nonce at the window base");
    refill(&mut w);
    let err = fill(&mut w, 5000).unwrap_err();
    assert!(err.contains("Custom(6016)") || err.contains("NonceUsed"), "{err}");

    fill(&mut w, u64::MAX).expect("the last u64 nonce is valid once");
    refill(&mut w);
    let err = fill(&mut w, u64::MAX).unwrap_err();
    assert!(err.contains("Custom(6016)") || err.contains("NonceUsed"), "{err}");
}

#[test]
fn census_rejects_multisig_disguised_as_a_balance() {
    let mut ctx = setup();
    let multisig = Keypair::new();
    // Multisig signer keys are arbitrary public keys, not authenticated
    // signers. Their bytes overlap the wallet/amount/state offsets that
    // a token-account parser would otherwise read.
    let mut signer_bytes = [0u8; 11 * 32];
    signer_bytes[29..61].copy_from_slice(ctx.wallet.pubkey().as_ref());
    signer_bytes[61..69].copy_from_slice(&u64::MAX.to_le_bytes());
    signer_bytes[105] = 1;
    let mut accounts = vec![meta_w(multisig.pubkey())];
    accounts.extend(signer_bytes.chunks_exact(32).map(|bytes| {
        meta_r(Pubkey::new_from_array(bytes.try_into().unwrap()))
    }));
    ctx.h.send(&[
        create_token_account(&ctx.h.payer.pubkey(), &multisig.pubkey(), 355, 10_000_000),
        Instruction { program_id: pk(TOKEN_ID), accounts, data: vec![19, 1] }, // InitializeMultisig2
    ], &[&multisig]).expect("real SPL multisig initialization");
    let data = ctx.h.account_data(&multisig.pubkey()).unwrap();
    assert_eq!(&data[32..64], ctx.wallet.pubkey().as_ref());
    assert_eq!(u64::from_le_bytes(data[64..72].try_into().unwrap()), u64::MAX);
    assert_eq!(data[108], 1);

    let before = ctx.h.account_data(&ctx.census_tree).unwrap();
    let ix = Instruction {
        program_id: pk(CENSUS_ID),
        accounts: vec![AccountMeta::new(ctx.h.payer.pubkey(), true), meta_r(ctx.wallet.pubkey()),
            meta_r(multisig.pubkey()), meta_w(ctx.census_tree)],
        data: ix_data("snapshot", &()),
    };
    let err = ctx.h.send_expect_err(&[ix], &[]);
    assert!(err.contains("Custom(6000)") || err.contains("NotATokenAccount"), "{err}");
    assert_eq!(ctx.h.account_data(&ctx.census_tree).unwrap(), before);
}

#[test]
fn cpi_wrapped_instructions_are_refused() {
    // register through a caller program: the registry checks stack height
    // before anything else, so introspection of the precompile can never
    // be fooled by an outer program.
    let mut ctx = setup();
    let msg = registration_message(&ctx.v);
    let sig = sign64(&ctx.wallet, &msg);
    let pre = ed25519_ix(&ctx.wallet.pubkey().to_bytes(), &sig, &msg);
    let err = ctx.h.send_expect_err(&[pre, via_cpi(register_ix(&ctx))], &[]);
    assert!(err.contains("Custom(6001)") || err.contains("CpiForbidden"), "{err}");

    // The pocket's state-changing instructions refuse the same way.
    let mut w = fill_world();
    let solver = w.solver.clone();
    let solver_pk = solver.pubkey();
    let args = fixture_intent(&w);
    let digest = intent_hash_of(&w, &args);
    let txi = vec![
        session_sig_ix(&w, &digest),
        via_cpi(fill_begin_ix(&w, &args, &w.usdc_price.clone(), None)),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 165_000_000),
        fill_end_ix(&w, &args, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6000)") || err.contains("CpiForbidden"), "{err}");
    assert_eq!(w.ctx.h.token_balance(&w.pocket_in), Some(25_000_000), "nothing moved");

    let revoke_digest = sha(&[b"ghostlink:revoke:v1", w.ctx.pocket.as_ref(), &0u64.to_le_bytes()]);
    let revoke = Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new(w.ctx.h.payer.pubkey(), true),
            meta_w(w.ctx.pocket),
            meta_r(w.ctx.registry_tree),
            meta_r(pk(SYSVAR_IX_ID)),
        ],
        data: ix_data("revoke_session", &SessionOrOwner::Session { webauthn: None }),
    };
    let err = w.ctx.h.send_expect_err(&[session_sig_ix(&w, &revoke_digest), via_cpi(revoke)], &[]);
    assert!(err.contains("Custom(6000)") || err.contains("CpiForbidden"), "{err}");

    let sweep = Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new(w.ctx.h.payer.pubkey(), true),
            meta_w(w.ctx.pocket),
            meta_w(w.ctx.home),
            meta_r(w.ctx.registry_tree),
            meta_r(pk(TOKEN_ID)),
            meta_r(pk(SYSVAR_IX_ID)),
        ],
        data: ix_data("sweep_home", &SessionOrOwner::Owner(owner_proof("sweep"))),
    };
    let err = w.ctx.h.send_expect_err(&[compute_budget(400_000), via_cpi(sweep)], &[]);
    assert!(err.contains("Custom(6000)") || err.contains("CpiForbidden"), "{err}");
}

#[test]
fn revoked_session_cannot_be_replayed() {
    let mut w = fill_world();
    // The relayer — or anyone reading the chain — holds the exact
    // open_session arguments, proof included.
    let replay = open_session_args(&w.ctx, "circuits/keys/login_proof.json", 0, ed25519_key33(&w.ctx.session), false);

    let revoke = Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new(w.ctx.h.payer.pubkey(), true),
            meta_w(w.ctx.pocket),
            meta_r(w.ctx.registry_tree),
            meta_r(pk(SYSVAR_IX_ID)),
        ],
        data: ix_data("revoke_session", &SessionOrOwner::Owner(owner_proof("revoke"))),
    };
    w.ctx.h.send(&[compute_budget(400_000), revoke], &[]).expect("revoke");
    let data = w.ctx.h.account_data(&w.ctx.pocket).unwrap();
    // 8 disc | 32 app_id | 32 domain | 32 home | 1 kind | 33 key | u64 expiry
    assert_eq!(u64::from_le_bytes(data[138..146].try_into().unwrap()), 0, "session revoked");

    // Resending the original open_session well before its expiry must
    // not bring the session back.
    set_clock(&mut w.ctx.h, FILL_SLOT + 1);
    let err = w.ctx.h.send_expect_err(&[compute_budget(400_000), open_session_ix(&w.ctx, &replay)], &[]);
    assert!(err.contains("Custom(6039)") || err.contains("SessionReplayed"), "{err}");
    let data = w.ctx.h.account_data(&w.ctx.pocket).unwrap();
    assert_eq!(u64::from_le_bytes(data[138..146].try_into().unwrap()), 0, "still revoked");

    // And the old session key still cannot spend.
    let mut args = fixture_intent(&w);
    args.nonce = 31;
    let digest = intent_hash_of(&w, &args);
    let solver = w.solver.clone();
    let solver_pk = solver.pubkey();
    let txi = vec![
        session_sig_ix(&w, &digest),
        fill_begin_ix(&w, &args, &w.usdc_price.clone(), None),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 165_000_000),
        fill_end_ix(&w, &args, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6015)") || err.contains("SessionExpired"), "{err}");
}

// ---- sweep, timelocked changes, revocation ------------------------------

fn owner_proof(name: &str) -> OwnerProofArgs {
    let actions = load_json("circuits/keys/owner_actions.json");
    let (a, b, c) = convert_proof(&actions[name]["proof"]);
    OwnerProofArgs {
        proof_a: a,
        proof_b: b,
        proof_c: c,
        registry_root: fe(actions[name]["publicSignals"][0].as_str().unwrap()),
    }
}

fn owner_action_ix(ctx: &Ctx, name: &str, data: Vec<u8>) -> Instruction {
    let _ = name;
    Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new(ctx.h.payer.pubkey(), true),
            meta_w(ctx.pocket),
            meta_r(ctx.registry_tree),
        ],
        data,
    }
}

#[test]
fn sweep_changes_and_revoke() {
    let mut w = fill_world();

    // Give the pocket something to sweep: tokens and loose lamports.
    let stash = Pubkey::new_unique();
    let home_ata = Pubkey::new_unique();
    w.ctx.h.svm.set_account(stash, token_account(&w.ctx.sol, &w.ctx.pocket, 165_000_000)).unwrap();
    w.ctx.h.svm.set_account(home_ata, token_account(&w.ctx.sol, &w.ctx.home, 0)).unwrap();
    w.ctx.h.svm.airdrop(&w.ctx.pocket, 5_000_000_000).unwrap();
    let home_before = w.ctx.h.svm.get_account(&w.ctx.home).map(|a| a.lamports).unwrap_or(0);

    // Sweep with the owner proof (works even without a session).
    let sweep = Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new(w.ctx.h.payer.pubkey(), true),
            meta_w(w.ctx.pocket),
            meta_w(w.ctx.home),
            meta_r(w.ctx.registry_tree),
            meta_r(pk(TOKEN_ID)),
            meta_r(pk(SYSVAR_IX_ID)),
            meta_w(stash),
            meta_w(home_ata),
        ],
        data: ix_data("sweep_home", &SessionOrOwner::Owner(owner_proof("sweep"))),
    };
    w.ctx.h.send(&[compute_budget(400_000), sweep], &[]).expect("sweep home");
    assert_eq!(w.ctx.h.token_balance(&home_ata), Some(165_000_000));
    assert!(w.ctx.h.svm.get_account(&stash).map(|a| a.data.is_empty()).unwrap_or(true), "stash closed");
    let home_after = w.ctx.h.svm.get_account(&w.ctx.home).unwrap().lamports;
    assert!(home_after > home_before + 4_000_000_000, "surplus lamports went home");

    // Propose a home change; executing early must fail; cancel works;
    // propose again and execute after the timelock.
    let new_home = label("new home address");
    let propose = |proof_name: &str| {
        #[derive(borsh::BorshSerialize)]
        struct Args(Change, OwnerProofArgs);
        ix_data("propose_change", &Args(Change::Home(new_home), owner_proof(proof_name)))
    };
    w.ctx.h.send(&[compute_budget(400_000), owner_action_ix(&w.ctx, "propose", propose("proposeHome"))], &[]).expect("propose");

    let execute = Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new_readonly(w.ctx.h.payer.pubkey(), true),
            meta_w(w.ctx.pocket),
        ],
        data: ix_data("execute_change", &()),
    };
    let err = w.ctx.h.send_expect_err(&[execute.clone()], &[]);
    assert!(err.contains("Custom(6036)") || err.contains("TimelockActive"), "{err}");

    let cancel = ix_data("cancel_change", &owner_proof("cancel"));
    w.ctx.h.send(&[compute_budget(400_000), owner_action_ix(&w.ctx, "cancel", cancel)], &[]).expect("cancel");

    // A cancelled authorization cannot be replayed to schedule the same change.
    set_clock(&mut w.ctx.h, FILL_SLOT + 1);
    let err = w.ctx.h.send_expect_err(&[compute_budget(400_000), owner_action_ix(&w.ctx, "propose", propose("proposeHome"))], &[]);
    assert!(err.contains("ProofInvalid") || err.contains("Custom(6002)"), "{err}");
    w.ctx.h.send(&[compute_budget(400_000), owner_action_ix(&w.ctx, "propose", propose("reproposeHome"))], &[]).expect("fresh re-propose");
    set_clock(&mut w.ctx.h, FILL_SLOT + TIMELOCK_SLOTS + 10);
    let err = w.ctx.h.send_expect_err(&[via_cpi(execute.clone())], &[]);
    assert!(err.contains("CpiForbidden") || err.contains("Custom(6000)"), "{err}");
    w.ctx.h.send(&[execute], &[]).expect("execute after timelock");
    let data = w.ctx.h.account_data(&w.ctx.pocket).unwrap();
    assert_eq!(&data[72..104], &new_home, "home updated after timelock");

    // Revoke by owner proof, then any fill is refused as expired.
    let revoke = Instruction {
        program_id: pk(POCKET_ID),
        accounts: vec![
            AccountMeta::new(w.ctx.h.payer.pubkey(), true),
            meta_w(w.ctx.pocket),
            meta_r(w.ctx.registry_tree),
            meta_r(pk(SYSVAR_IX_ID)),
        ],
        data: ix_data("revoke_session", &SessionOrOwner::Owner(owner_proof("revokeAfterChanges"))),
    };
    w.ctx.h.send(&[compute_budget(400_000), revoke], &[]).expect("revoke");
    set_clock(&mut w.ctx.h, FILL_SLOT + TIMELOCK_SLOTS + 20);

    let mut args = fixture_intent(&w);
    args.nonce = 30;
    args.deadline_slot = FILL_SLOT + TIMELOCK_SLOTS + 100;
    let digest = intent_hash_of(&w, &args);
    let solver = w.solver.clone();
    let solver_pk = solver.pubkey();
    let txi = vec![
        session_sig_ix(&w, &digest),
        fill_begin_ix(&w, &args, &w.usdc_price.clone(), None),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, 165_000_000),
        fill_end_ix(&w, &args, &w.pocket_out.clone(), Some(&w.sol_price.clone())),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6015)") || err.contains("SessionExpired"), "{err}");
}

// ---- P-256 (passkey) session over WebAuthn -------------------------------

fn base64url(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(CHARS[(n >> 18) as usize & 63] as char);
        out.push(CHARS[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(CHARS[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(CHARS[n as usize & 63] as char);
        }
    }
    out
}

#[test]
fn p256_requires_explicit_unpriced_permission() {
    use p256::ecdsa::{signature::Signer as _, Signature, SigningKey};

    let mut w = fill_world();
    let fx = load_json("circuits/keys/login_p256_proof.json");
    let seed = hex32(fx["seed"].as_str().unwrap());
    let compressed: [u8; 33] = hexv(fx["compressedPubkey"].as_str().unwrap()).try_into().unwrap();

    let signing = SigningKey::from_slice(&seed).expect("fixture seed is a valid P-256 scalar");
    assert_eq!(
        signing.verifying_key().to_encoded_point(true).as_bytes(),
        compressed,
        "p256 fixture key mismatch"
    );

    // Rotate the pocket's session to the passkey. Its proof binds an
    // expiry one slot after the Ed25519 session's: a later expiry is what
    // the replay guard demands of every new session.
    set_clock(&mut w.ctx.h, OPEN_SLOT + 1);
    let mut args = open_session_args(&w.ctx, "circuits/keys/login_p256_proof.json", 1, compressed, false);
    args.session_key = compressed;
    args.session_expiry_slot = EXPIRY_SLOT + 1;
    // Renewal must bind and preserve the stored policy, even if the
    // submitter supplies a different policy argument. Subsequent fills
    // below still sign the original policy hash.
    let mut ignored_policy = w.ctx.policy.clone();
    ignored_policy.daily_cap_usd_e6 += 1;
    args.policy = Some(ignored_policy);
    w.ctx.h.send(&[compute_budget(400_000), open_session_ix(&w.ctx, &args)], &[]).expect("rotate to p256 session");
    set_clock(&mut w.ctx.h, FILL_SLOT);

    // A passkey alone does not approve unpriced trading in PocketV3.
    let nft = label("nft mint");
    let pocket_nft = Pubkey::new_unique();
    let solver_nft = Pubkey::new_unique();
    let solver = w.solver.clone();
    let solver_pk = solver.pubkey();
    w.ctx.h.svm.set_account(pocket_nft, token_account(&nft, &w.ctx.pocket, 0)).unwrap();
    w.ctx.h.svm.set_account(solver_nft, token_account(&nft, &solver_pk, 5)).unwrap();

    let mut intent = fixture_intent(&w);
    intent.nonce = 40;
    intent.in_max = 10_000_000;
    intent.out_mint = nft;
    intent.out_min = 1;
    let challenge = intent_hash_of(&w, &intent);

    // WebAuthn assertion: authData = rpIdHash | flags(UP|UV) | counter.
    let mut auth_data = sha(&[b"ghostlink.dev"]).to_vec();
    auth_data.push(0x05);
    auth_data.extend_from_slice(&[0, 0, 0, 1]);
    let cdj = format!(
        r#"{{"type":"webauthn.get","challenge":"{}","origin":"https://ghostlink.dev"}}"#,
        base64url(&challenge)
    )
    .into_bytes();
    let mut message = auth_data.clone();
    message.extend_from_slice(&sha(&[&cdj]));

    let sig: Signature = signing.sign(&message);
    let sig = sig.normalize_s().unwrap_or(sig);
    let sig_bytes: [u8; 64] = sig.to_bytes().as_slice().try_into().unwrap();

    let webauthn = WebauthnData {
        authenticator_data: auth_data,
        client_data_json: cdj,
    };

    let priced_output = w.pocket_out;
    w.pocket_out = pocket_nft;
    let txi = vec![
        secp256r1_ix(&compressed, &sig_bytes, &message),
        fill_begin_ix(&w, &intent, &w.usdc_price.clone(), Some(webauthn)),
        spl_transfer(&solver_nft, &pocket_nft, &solver_pk, 1),
        fill_end_ix(&w, &intent, &pocket_nft, None),
    ];
    let err = w.ctx.h.send_expect_err(&txi, &[&solver]);
    assert!(err.contains("Custom(6027)") || err.contains("NoOracleViolation"), "{err}");
    assert_eq!(w.ctx.h.token_balance(&pocket_nft), Some(0));
    assert_eq!(w.ctx.h.token_balance(&w.solver_in), Some(0));

    // Passkey signing still works for an ordinary oracle-priced fill.
    w.pocket_out = priced_output;
    intent.out_mint = w.ctx.sol;
    intent.out_min = 64_000_000; // $10 of SOL at the pinned fixture price
    let challenge = intent_hash_of(&w, &intent);
    let mut auth_data = sha(&[b"ghostlink.dev"]).to_vec();
    auth_data.extend_from_slice(&[0x05, 0, 0, 0, 2]);
    let cdj = format!(r#"{{"type":"webauthn.get","challenge":"{}","origin":"https://ghostlink.dev"}}"#,
        base64url(&challenge)).into_bytes();
    let mut message = auth_data.clone();
    message.extend_from_slice(&sha(&[&cdj]));
    let sig: Signature = signing.sign(&message);
    let sig = sig.normalize_s().unwrap_or(sig);
    let signature: [u8; 64] = sig.to_bytes().as_slice().try_into().unwrap();
    let tx = vec![secp256r1_ix(&compressed, &signature, &message),
        fill_begin_ix(&w, &intent, &w.usdc_price, Some(WebauthnData { authenticator_data: auth_data, client_data_json: cdj })),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver_pk, intent.out_min),
        fill_end_ix(&w, &intent, &w.pocket_out, Some(&w.sol_price))];
    w.ctx.h.send(&tx, &[&solver]).expect("priced passkey fill");
    assert_eq!(w.ctx.h.token_balance(&priced_output), Some(64_000_000));
}
