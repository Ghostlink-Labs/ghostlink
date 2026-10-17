use super::*;

#[test]
fn recovery_refuses_external_destination_authorities() {
    for delegate in [true, false] {
        let mut w = fill_world();
        let source = Pubkey::new_unique();
        w.ctx.h.svm.set_account(source, token_account(&w.ctx.sol, &w.ctx.pocket, 123)).unwrap();
        let destination = Pubkey::new_unique();
        let mut account = token_account(&w.ctx.sol, &w.ctx.home, 0);
        // Valid SPL states: the home owner previously approved a delegate or
        // set an external close authority. A relayer must not redirect recovery
        // into that old authority merely because the owner/mint still match.
        if delegate {
            account.data[72..76].copy_from_slice(&1u32.to_le_bytes());
            account.data[76..108].copy_from_slice(w.solver.pubkey().as_ref());
            account.data[121..129].copy_from_slice(&u64::MAX.to_le_bytes());
        } else {
            account.data[129..133].copy_from_slice(&1u32.to_le_bytes());
            account.data[133..165].copy_from_slice(w.solver.pubkey().as_ref());
        }
        w.ctx.h.svm.set_account(destination, account).unwrap();
        let before = w.ctx.h.account_data(&w.ctx.pocket).unwrap();
        let sweep = Instruction { program_id: pk(POCKET_ID), accounts: vec![
            AccountMeta::new(w.ctx.h.payer.pubkey(), true), meta_w(w.ctx.pocket), meta_w(w.ctx.home),
            meta_r(w.ctx.registry_tree), meta_r(pk(TOKEN_ID)), meta_r(pk(SYSVAR_IX_ID)),
            meta_w(source), meta_w(destination)],
            data: ix_data("sweep_home", &SessionOrOwner::Owner(owner_proof("sweep"))) };
        let err = w.ctx.h.send_expect_err(&[compute_budget(400_000), sweep], &[]);
        assert!(err.contains("Custom(6033)"), "{err}");
        assert_eq!(w.ctx.h.account_data(&w.ctx.pocket).unwrap(), before);
        assert_eq!(w.ctx.h.token_balance(&source), Some(123));
        assert_eq!(w.ctx.h.token_balance(&destination), Some(0));
    }
}

fn foreign_close_authority(w: &mut FillWorld) {
    let solver = w.solver.clone();
    w.ctx.h.svm.set_account(w.pocket_out, token_account(&w.ctx.sol, &solver.pubkey(), 123)).unwrap();
    let set = |kind: u8, authority: Pubkey| Instruction { program_id: pk(TOKEN_ID),
        accounts: vec![meta_w(w.pocket_out), AccountMeta::new_readonly(solver.pubkey(), true)],
        data: [vec![6, kind, 1], authority.to_bytes().to_vec()].concat() };
    // Real SPL SetAuthority preserves a non-native account's explicit close
    // authority when its owner changes. No forged pocket signature is used.
    w.ctx.h.send(&[set(3, solver.pubkey()), set(2, w.ctx.pocket)], &[&solver]).unwrap();
    let data = w.ctx.h.account_data(&w.pocket_out).unwrap();
    assert_eq!(&data[32..64], w.ctx.pocket.as_ref());
    assert_eq!(&data[129..133], &[1, 0, 0, 0]);
    assert_eq!(&data[133..165], solver.pubkey().as_ref());
}

#[test]
fn recovery_does_not_depend_on_a_foreign_close_authority() {
    let mut w = fill_world();
    foreign_close_authority(&mut w);
    let home_token = Pubkey::new_unique();
    w.ctx.h.svm.set_account(home_token, token_account(&w.ctx.sol, &w.ctx.home, 0)).unwrap();
    let sweep = Instruction { program_id: pk(POCKET_ID), accounts: vec![
        AccountMeta::new(w.ctx.h.payer.pubkey(), true), meta_w(w.ctx.pocket), meta_w(w.ctx.home),
        meta_r(w.ctx.registry_tree), meta_r(pk(TOKEN_ID)), meta_r(pk(SYSVAR_IX_ID)),
        meta_w(w.pocket_out), meta_w(home_token)],
        data: ix_data("sweep_home", &SessionOrOwner::Owner(owner_proof("sweep"))) };
    w.ctx.h.send(&[compute_budget(400_000), sweep], &[]).expect("owner must recover tokens without another account's close authority");
    assert_eq!(w.ctx.h.token_balance(&home_token), Some(123));
    assert_eq!(w.ctx.h.token_balance(&w.pocket_out), Some(0));
}

#[test]
fn fills_refuse_output_accounts_with_an_external_close_authority() {
    let mut w = fill_world();
    foreign_close_authority(&mut w);
    let args = fixture_intent(&w);
    let solver = w.solver.clone();
    let tx = vec![session_sig_ix(&w, &intent_hash_of(&w, &args)), fill_begin_ix(&w, &args, &w.usdc_price, None),
        spl_transfer(&w.solver_out, &w.pocket_out, &solver.pubkey(), args.out_min),
        fill_end_ix(&w, &args, &w.pocket_out, Some(&w.sol_price))];
    let before = w.ctx.h.account_data(&w.ctx.pocket).unwrap();
    let err = w.ctx.h.send_expect_err(&tx, &[&solver]);
    assert!(err.contains("Custom(6033)"), "{err}");
    assert_eq!(w.ctx.h.account_data(&w.ctx.pocket).unwrap(), before);
    assert_eq!(w.ctx.h.token_balance(&w.pocket_in), Some(25_000_000));
    assert_eq!(w.ctx.h.token_balance(&w.pocket_out), Some(123));
}
