//! Included by flows.rs: executes the real compiled PocketV3 program.
use super::*;

fn world() -> FillWorld {
    let mut w = fill_world_with_policy(true);
    let mint = label("unpriced token");
    let sp = w.solver.pubkey();
    w.ctx.h.svm.set_account(w.pocket_in, token_account(&w.ctx.usdc, &w.ctx.pocket, 100_000_000)).unwrap();
    // A donation predates the trade; only measured acquired units count.
    w.ctx.h.svm.set_account(w.pocket_out, token_account(&mint, &w.ctx.pocket, 1_000)).unwrap();
    w.ctx.h.svm.set_account(w.solver_out, token_account(&mint, &sp, 1_000)).unwrap();
    w
}

fn buy(w: &FillWorld, nonce: u64, cost: u64, minimum: u64, delivered: u64) -> Vec<Instruction> {
    let args = IntentArgs { nonce, in_max: cost, out_mint: label("unpriced token"),
        out_min: minimum, deadline_slot: w.ctx.h.svm.get_sysvar::<Clock>().slot + 100, ..fixture_intent(w) };
    vec![session_sig_ix(w, &intent_hash_of(w, &args)),
        fill_begin_ix(w, &args, &w.usdc_price, None),
        spl_transfer(&w.solver_out, &w.pocket_out, &w.solver.pubkey(), delivered),
        fill_end_ix(w, &args, &w.pocket_out, None)]
}

fn exit(w: &mut FillWorld, nonce: u64, quantity: u64, minimum: u64, delivered: u64) -> Vec<Instruction> {
    let args = IntentArgs { nonce, in_mint: label("unpriced token"), in_max: quantity,
        out_mint: w.ctx.usdc, out_min: minimum,
        deadline_slot: w.ctx.h.svm.get_sysvar::<Clock>().slot + 100, ..fixture_intent(w) };
    std::mem::swap(&mut w.pocket_in, &mut w.pocket_out);
    std::mem::swap(&mut w.solver_in, &mut w.solver_out);
    let instructions = vec![session_sig_ix(w, &intent_hash_of(w, &args)),
        fill_begin_ix(w, &args, &pk(POCKET_ID), None),
        spl_transfer(&w.solver_out, &w.pocket_out, &w.solver.pubkey(), delivered),
        fill_end_ix(w, &args, &w.pocket_out, Some(&w.usdc_price))];
    std::mem::swap(&mut w.pocket_in, &mut w.pocket_out);
    std::mem::swap(&mut w.solver_in, &mut w.solver_out);
    instructions
}

fn ledger(w: &FillWorld) -> (u64, u64, u64) {
    let data = w.ctx.h.account_data(&w.ctx.pocket).unwrap();
    assert_eq!(data.len(), 3293);
    assert_eq!(&data[..8], &sha(&[b"account:PocketV3"])[..8]);
    let policy_end = 146 + borsh::to_vec(&w.ctx.policy).unwrap().len();
    let pending = if data[policy_end] == 0 { 1 } else {
        // This suite stages the conservative policy only.
        assert_eq!(data[policy_end + 1], 1);
        2 + borsh::to_vec(&feeds_policy()).unwrap().len() + 8
    };
    let offset = policy_end + pending + 297;
    let value = |i: usize| u64::from_le_bytes(data[i..i + 8].try_into().unwrap());
    (value(offset), value(offset + 8 + 96), value(offset + 8 + 104))
}

fn refused_without_movement(w: &mut FillWorld, tx: &[Instruction], expected: &str) {
    let before = w.ctx.h.account_data(&w.ctx.pocket).unwrap();
    let accounts = [w.pocket_in, w.pocket_out, w.solver_in, w.solver_out];
    let balances = accounts.map(|k| w.ctx.h.token_balance(&k));
    let solver = w.solver.clone();
    let err = w.ctx.h.send_expect_err(tx, &[&solver]);
    assert!(err.contains(expected), "expected {expected}: {err}");
    assert_eq!(before, w.ctx.h.account_data(&w.ctx.pocket).unwrap());
    assert_eq!(balances, accounts.map(|k| w.ctx.h.token_balance(&k)));
}

#[test]
fn unpriced_round_trip_caps_loss_exit_and_atomic_rollback() {
    let mut w = world();
    let solver = w.solver.clone();
    let tx = buy(&w, 7, 10_000_000, 90, 100);
    w.ctx.h.send(&tx, &[&solver]).expect("explicit software-session buy");
    assert_eq!(ledger(&w), (10_000_000, 100, 10_000_000));
    let tx = exit(&mut w, 8, 101, 1, 1);
    refused_without_movement(&mut w, &tx, "Custom(6044)"); // donated units are not authorized
    let tx = buy(&w, 9, 20_000_000, 1, 1);
    refused_without_movement(&mut w, &tx, "Custom(6043)"); // aggregate acquisition-cost cap
    let tx = buy(&w, 10, 21_000_000, 1, 1);
    refused_without_movement(&mut w, &tx, "Custom(6027)"); // per-buy no-oracle cap
    let tx = buy(&w, 11, 5_000_000, 20, 19);
    refused_without_movement(&mut w, &tx, "Custom(6029)"); // measured output underfill rolls back
    let tx = exit(&mut w, 12, 50, 1_000_000, 999_999);
    refused_without_movement(&mut w, &tx, "Custom(6029)");
    let tx = exit(&mut w, 13, 50, 1_000_000, 1_000_000);
    w.ctx.h.send(&tx, &[&solver]).expect("sell half at a loss: $5 cost, $1 returned");
    assert_eq!(ledger(&w), (10_000_000, 50, 5_000_000));
    let tx = buy(&w, 14, 15_000_000, 50, 50);
    w.ctx.h.send(&tx, &[&solver]).expect("released exposure can be reused");
    assert_eq!(ledger(&w), (25_000_000, 100, 20_000_000));
    let tx = exit(&mut w, 15, 100, 1, 1);
    w.ctx.h.send(&tx, &[&solver]).expect("full loss exit retires position");
    assert_eq!(ledger(&w), (25_000_000, 0, 0));
    let tx = buy(&w, 16, 6_000_000, 1, 1);
    refused_without_movement(&mut w, &tx, "Custom(6042)"); // sells never refund daily buy budget
    let tx = exit(&mut w, 17, 1, 1, 1);
    refused_without_movement(&mut w, &tx, "Custom(6044)"); // only original donation remains
}

#[test]
fn sweep_retires_permission_without_refunding_daily_budget() {
    let mut w = world();
    let solver = w.solver.clone();
    let tx = buy(&w, 7, 10_000_000, 100, 100);
    w.ctx.h.send(&tx, &[&solver]).unwrap();
    let home_token = Pubkey::new_unique();
    w.ctx.h.svm.set_account(home_token, token_account(&label("unpriced token"), &w.ctx.home, 0)).unwrap();
    let sweep = Instruction { program_id: pk(POCKET_ID), accounts: vec![
        AccountMeta::new(w.ctx.h.payer.pubkey(), true), meta_w(w.ctx.pocket), meta_w(w.ctx.home),
        meta_r(w.ctx.registry_tree), meta_r(pk(TOKEN_ID)), meta_r(pk(SYSVAR_IX_ID)),
        meta_w(w.pocket_out), meta_w(home_token)],
        data: ix_data("sweep_home", &SessionOrOwner::Owner(owner_proof("sweep"))) };
    w.ctx.h.send(&[compute_budget(400_000), sweep], &[]).expect("owner recovery of tracked and donated tokens");
    assert_eq!(w.ctx.h.token_balance(&home_token), Some(1_100));
    assert_eq!(ledger(&w), (10_000_000, 0, 0));
    w.ctx.h.svm.set_account(w.pocket_out, token_account(&label("unpriced token"), &w.ctx.pocket, 100)).unwrap();
    let tx = exit(&mut w, 8, 100, 1, 1);
    refused_without_movement(&mut w, &tx, "Custom(6044)");
}

#[test]
fn speculative_fields_require_the_owners_exact_proof() {
    let mut ctx = setup();
    ctx.policy = speculative_policy();
    register(&mut ctx);
    snapshot(&mut ctx);
    set_clock(&mut ctx.h, OPEN_SLOT);
    let args = open_session_args(&ctx, "circuits/keys/login_speculative_proof.json", 0,
        ed25519_key33(&ctx.session), true);
    for field in 0..5 {
        let mut tampered = args.clone();
        let policy = tampered.policy.as_mut().unwrap();
        let spec = policy.speculative.as_mut().unwrap();
        match field {
            0 => spec.daily_buy_cap_usd_e6 += 1,
            1 => spec.max_cost_exposure_usd_e6 += 1,
            2 => spec.max_positions += 1,
            3 => { spec.base_mints.pop(); },
            _ => policy.speculative = None,
        }
        let err = ctx.h.send_expect_err(&[compute_budget(400_000), open_session_ix(&ctx, &tampered)], &[]);
        assert!(err.contains("Custom(6002)") || err.contains("ProofInvalid"), "{err}");
    }
    ctx.h.send(&[compute_budget(400_000), open_session_ix(&ctx, &args)], &[]).expect("exact consent accepted");
}

#[test]
fn renewal_and_day_roll_keep_exposure_but_reset_only_daily_spending() {
    let mut w = world();
    let solver = w.solver.clone();
    let tx = buy(&w, 7, 10_000_000, 100, 100);
    w.ctx.h.send(&tx, &[&solver]).unwrap();
    set_clock(&mut w.ctx.h, FILL_SLOT + TIMELOCK_SLOTS);
    let mut args = open_session_args(&w.ctx, "circuits/keys/login_speculative_renew_proof.json", 0,
        ed25519_key33(&w.ctx.session), false);
    args.session_expiry_slot = EXPIRY_SLOT + TIMELOCK_SLOTS;
    args.claim_holdings = false;
    w.ctx.h.send(&[compute_budget(400_000), open_session_ix(&w.ctx, &args)], &[]).expect("renew after a day");
    assert_eq!(ledger(&w), (10_000_000, 100, 10_000_000));
    let tx = buy(&w, 8, 20_000_000, 1, 1);
    refused_without_movement(&mut w, &tx, "Custom(6043)"); // the day does not reset exposure
    let tx = buy(&w, 9, 10_000_000, 100, 100);
    w.ctx.h.send(&tx, &[&solver]).expect("new daily window");
    assert_eq!(ledger(&w), (10_000_000, 200, 20_000_000));
}

#[test]
fn policy_change_freezes_buys_and_requires_exit_or_recovery() {
    let mut w = world();
    let solver = w.solver.clone();
    let tx = buy(&w, 7, 10_000_000, 100, 100);
    w.ctx.h.send(&tx, &[&solver]).unwrap();
    let fx = load_json("circuits/keys/owner_speculative_policy_proof.json");
    let (a, b, c) = convert_proof(&fx["proof"]);
    let proof = OwnerProofArgs { proof_a: a, proof_b: b, proof_c: c,
        registry_root: fe(fx["publicSignals"][0].as_str().unwrap()) };
    let propose = Instruction { program_id: pk(POCKET_ID), accounts: vec![
        AccountMeta::new(w.ctx.h.payer.pubkey(), true), meta_w(w.ctx.pocket), meta_r(w.ctx.registry_tree)],
        data: ix_data("propose_change", &(Change::Policy(feeds_policy()), proof)) };
    w.ctx.h.send(&[compute_budget(400_000), propose], &[]).expect("owner stages conservative policy");
    let tx = buy(&w, 8, 1_000_000, 1, 1);
    refused_without_movement(&mut w, &tx, "Custom(6034)");
    let tx = exit(&mut w, 9, 10, 1, 1);
    w.ctx.h.send(&tx, &[&solver]).expect("pending policy permits reducing exposure");
    let execute = Instruction { program_id: pk(POCKET_ID), accounts: vec![
        AccountMeta::new(w.ctx.h.payer.pubkey(), true), meta_w(w.ctx.pocket)], data: ix_data("execute_change", &()) };
    let err = w.ctx.h.send_expect_err(&[execute.clone()], &[]);
    assert!(err.contains("Custom(6036)"), "{err}");
    set_clock(&mut w.ctx.h, FILL_SLOT + TIMELOCK_SLOTS);
    let err = w.ctx.h.send_expect_err(&[execute.clone()], &[]);
    assert!(err.contains("Custom(6046)"), "{err}");
    assert_eq!(ledger(&w), (10_000_000, 90, 9_000_000));
    // The session has expired. An owner proof still recovers everything.
    let home_token = Pubkey::new_unique();
    w.ctx.h.svm.set_account(home_token, token_account(&label("unpriced token"), &w.ctx.home, 0)).unwrap();
    let sweep = Instruction { program_id: pk(POCKET_ID), accounts: vec![
        AccountMeta::new(w.ctx.h.payer.pubkey(), true), meta_w(w.ctx.pocket), meta_w(w.ctx.home),
        meta_r(w.ctx.registry_tree), meta_r(pk(TOKEN_ID)), meta_r(pk(SYSVAR_IX_ID)),
        meta_w(w.pocket_out), meta_w(home_token)],
        data: ix_data("sweep_home", &SessionOrOwner::Owner(owner_proof("sweepAfterAction"))) };
    w.ctx.h.send(&[compute_budget(400_000), sweep], &[]).expect("recovery during a pending policy change");
    w.ctx.h.send(&[execute], &[]).expect("execute after exposure is cleared");
    w.ctx.policy = feeds_policy();
    assert_eq!(ledger(&w), (10_000_000, 0, 0));
    assert_eq!(w.ctx.h.token_balance(&home_token), Some(1_090));
}
