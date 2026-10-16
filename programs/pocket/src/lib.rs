//! GhostLink pocket program.
//!
//! In plain language: a pocket is a small spending account one app can
//! use on your behalf, with hard rules it can never talk its way around.
//! The app proposes intents ("spend at most X, receive at least Y"); a
//! solver fills them, and the fill either delivers what the intent
//! promised inside the same transaction or everything reverts. Prices
//! are checked against an oracle you chose, spending has a daily cap,
//! and the only exit for funds is your home address — changing that
//! takes your secret plus a 24-hour wait.
//!
//! Safety invariants (tested, to be audited, see docs/build-plan.md §6):
//! - no instruction moves tokens to a non-home address except an atomic
//!   begin/end fill pair;
//! - the pocket PDA only ever signs SPL Token Transfer/CloseAccount CPIs
//!   it issues itself (token.rs holds every `invoke_signed` call site);
//! - `open_session` can never change the home or policy of an existing
//!   pocket;
//! - every root is checked against a 128-root history ring, never a
//!   single current root;
//! - `fill_end` measures delivery on the very token account `fill_begin`
//!   snapshotted;
//! - a captured `open_session` cannot be replayed: each session must
//!   expire later than every session before it.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use solana_sha256_hasher::hashv;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_lang::Discriminator;

use ghostlink_verifier::encoding::{is_in_field, reduce_to_field, split32, u64_fe, ZERO_FE, ONE_FE};
use ghostlink_verifier::intent::Intent;
use ghostlink_verifier::merkle::tree_account;
use ghostlink_verifier::poseidon;
use ghostlink_verifier::{verify_login, verify_owner};

pub mod oracle;
pub mod precompile;
pub mod state;
pub mod token;

use oracle::{read_price, usd_e6};
use precompile::{check_session_signature, WebauthnData};
use state::*;
use token::{close_pocket_account, parse_token_account, transfer_from_pocket, TOKEN_PROGRAM_ID};

declare_id!("HbSux9YnTupzNiRUwdR2mjTpJJryx25RV42wry4kCwiH");

pub const REGISTRY_PROGRAM_ID: Pubkey = pubkey!("54EZ5ZkUANBs1SfQoXaU5EQSR8VAaD3XDtKEZGp6KjRv");
pub const CENSUS_PROGRAM_ID: Pubkey = pubkey!("CvRA16GAa5ynUE3bzgMWuPYTbHLsdvyBydJoZVft5x9d");

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OpenSessionArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub registry_root: [u8; 32],
    pub census_root: [u8; 32],
    pub domain_hash: [u8; 32],
    pub app_id: [u8; 32],
    pub mint: Pubkey,
    pub threshold: u64,
    pub min_slot: u64,
    pub claim_holdings: bool,
    pub session_kind: u8,
    pub session_key: [u8; 33],
    pub session_expiry_slot: u64,
    pub home: Pubkey,
    /// Required when the pocket does not exist yet; ignored afterwards.
    pub policy: Option<Policy>,
}

/// The intent fields; canonical bytes and hash come from
/// `ghostlink_verifier::intent::Intent` (vector-tested against TS).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct IntentArgs {
    pub nonce: u64,
    pub in_mint: Pubkey,
    pub in_max: u64,
    pub out_mint: Pubkey,
    pub out_min: u64,
    pub deadline_slot: u64,
    pub policy_hash: [u8; 32],
}

impl IntentArgs {
    fn to_intent(&self, pocket: &Pubkey) -> Intent {
        Intent {
            pocket: pocket.to_bytes(),
            nonce: self.nonce,
            in_mint: self.in_mint.to_bytes(),
            in_max: self.in_max,
            out_mint: self.out_mint.to_bytes(),
            out_min: self.out_min,
            deadline_slot: self.deadline_slot,
            policy_hash: self.policy_hash,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OwnerProofArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub registry_root: [u8; 32],
}

/// Authorization for sweep and revoke: the live session signature, or an
/// owner proof that works even with no session at all.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum SessionOrOwner {
    Session { webauthn: Option<WebauthnData> },
    Owner(OwnerProofArgs),
}

#[program]
pub mod ghostlink_pocket {
    use super::*;

    /// Verifies a login proof, then creates the pocket (first time) or
    /// rotates its session (afterwards). Never touches home or policy of
    /// an existing pocket.
    pub fn open_session_v2(ctx: Context<OpenSession>, args: OpenSessionArgs) -> Result<()> {
        require!(get_stack_height() == 1, PocketError::CpiForbidden);
        let clock = Clock::get()?;

        for fe in [&args.registry_root, &args.census_root, &args.domain_hash, &args.app_id] {
            require!(is_in_field(fe), PocketError::NotInField);
        }
        require!(
            args.session_kind == SESSION_KIND_ED25519 || args.session_kind == SESSION_KIND_P256,
            PocketError::BadSessionKey
        );
        if args.session_kind == SESSION_KIND_ED25519 {
            require!(args.session_key[32] == 0, PocketError::BadSessionKey);
        }

        // Root membership, against history rings, never a single root.
        check_tree_account(
            &ctx.accounts.registry_tree,
            &REGISTRY_PROGRAM_ID,
            b"tree",
            &args.registry_root,
            PocketError::UnknownRegistryRoot,
        )?;
        if args.claim_holdings {
            check_tree_account(
                &ctx.accounts.census_tree,
                &CENSUS_PROGRAM_ID,
                b"census",
                &args.census_root,
                PocketError::UnknownCensusRoot,
            )?;
            require!(
                args.min_slot >= clock.slot.saturating_sub(MAX_MIN_SLOT_LAG),
                PocketError::SnapshotTooOld
            );
        }

        let pocket = &mut ctx.accounts.pocket;
        let created = pocket.app_id == [0u8; 32];

        // Session expiry within the governing policy.
        let governing_policy = if created {
            args.policy.as_ref().ok_or(error!(PocketError::PolicyRequired))?
        } else {
            &pocket.policy
        };
        require!(governing_policy.validate(), PocketError::BadPolicy);
        let session_max = governing_policy.session_max_slots;
        // The prover approves the complete policy, not a relayer's choice.
        // Renewal binds the stored policy; a policy change invalidates an
        // outstanding authorization made under the previous policy.
        let authorization_context = reduce_to_field(&hashv(&[
            b"ghostlink:open-session:v2", ctx.program_id.as_ref(),
            REGISTRY_PROGRAM_ID.as_ref(), CENSUS_PROGRAM_ID.as_ref(),
            &governing_policy.hash(), &[args.session_kind],
        ]).to_bytes());
        require!(
            args.session_expiry_slot > clock.slot
                && args.session_expiry_slot <= clock.slot.saturating_add(session_max),
            PocketError::BadSessionExpiry
        );

        // Re-derive the bound commitments from the raw arguments.
        let key32 = Pocket::session_key32(args.session_kind, &args.session_key);
        let session_commitment = poseidon::session_commitment(&key32, args.session_expiry_slot)
            .map_err(|_| error!(PocketError::HashFailed))?;
        let home_hash = poseidon::home_hash(&args.home.to_bytes())
            .map_err(|_| error!(PocketError::HashFailed))?;

        let (mint_hi, mint_lo) = split32(&args.mint.to_bytes());
        let public_inputs: [[u8; 32]; 12] = [
            args.registry_root,
            args.census_root,
            args.domain_hash,
            args.app_id,
            mint_hi,
            mint_lo,
            u64_fe(args.threshold),
            u64_fe(args.min_slot),
            session_commitment,
            home_hash,
            if args.claim_holdings { ONE_FE } else { ZERO_FE },
            authorization_context,
        ];
        verify_login(&args.proof_a, &args.proof_b, &args.proof_c, &public_inputs)
            .map_err(|_| error!(PocketError::ProofInvalid))?;

        // Replay guard: the proof binds (key, expiry), and anyone who saw
        // this instruction could resend it. Demanding a strictly later
        // expiry than every earlier session makes a resend worthless —
        // in particular it can never undo a revoke.
        require!(
            args.session_expiry_slot > pocket.max_session_expiry_slot,
            PocketError::SessionReplayed
        );

        if created {
            let policy = args.policy.clone().unwrap();
            require!(policy.validate(), PocketError::BadPolicy);
            pocket.app_id = args.app_id;
            pocket.domain_hash = args.domain_hash;
            pocket.home = args.home;
            pocket.policy = policy;
            pocket.pending = None;
            pocket.day_start_slot = clock.slot;
            pocket.spent_today_usd_e6 = 0;
            pocket.nonce_bitmap = [0u8; NONCE_BITMAP_BYTES];
            pocket.nonce_base = 0;
            pocket.owner_action_nonce = 0;
            pocket.bump = ctx.bumps.pocket;
        } else {
            // The proof bound this domain, home — and therefore this pocket.
            require!(pocket.domain_hash == args.domain_hash, PocketError::DomainMismatch);
            require!(pocket.home == args.home, PocketError::HomeMismatch);
        }

        pocket.session_kind = args.session_kind;
        pocket.session_key = args.session_key;
        pocket.session_expiry_slot = args.session_expiry_slot;
        pocket.max_session_expiry_slot = args.session_expiry_slot;

        emit!(SessionOpened {
            pocket: pocket.key(),
            app_id: args.app_id,
            created,
            session_expiry_slot: args.session_expiry_slot,
        });
        Ok(())
    }

    /// First half of an atomic fill: checks the session signature over
    /// the exact intent bytes, the policy, the daily cap and the
    /// guaranteed presence of a matching `fill_end` later in this very
    /// transaction, then hands the input to the solver.
    pub fn fill_begin(
        ctx: Context<FillBegin>,
        args: IntentArgs,
        webauthn: Option<WebauthnData>,
    ) -> Result<()> {
        require!(get_stack_height() == 1, PocketError::CpiForbidden);
        let clock = Clock::get()?;
        let pocket_key = ctx.accounts.pocket.key();
        let pocket = &mut ctx.accounts.pocket;

        require!(clock.slot < pocket.session_expiry_slot, PocketError::SessionExpired);
        require!(clock.slot <= args.deadline_slot, PocketError::DeadlinePassed);
        require!(!pocket.nonce_used(args.nonce), PocketError::NonceUsed);
        require!(
            args.policy_hash == pocket.policy.hash(),
            PocketError::PolicyHashMismatch
        );

        let intent = args.to_intent(&pocket_key);
        let intent_hash = hashv(&[&intent.to_bytes()]).to_bytes();

        // Session signature through the precompile immediately before.
        let ixs = ctx.accounts.instructions.to_account_info();
        let current = load_current_index_checked(&ixs)? as usize;
        require!(current > 0, PocketError::MissingSignature);
        let pre = load_instruction_at_checked(current - 1, &ixs)?;
        check_session_signature(
            &pre,
            (current - 1) as u16,
            pocket.session_kind,
            &pocket.session_key,
            &intent_hash,
            webauthn.as_ref(),
        )?;

        // A matching fill_end must be the next pocket instruction in this
        // same transaction; anything else between the pair is refused.
        let args_bytes = args.try_to_vec()?;
        let mut found_end = false;
        let mut i = current + 1;
        while let Ok(ix) = load_instruction_at_checked(i, &ixs) {
            if ix.program_id == crate::ID {
                require!(
                    ix.data.len() > 8 && &ix.data[..8] == crate::instruction::FillEnd::DISCRIMINATOR,
                    PocketError::FillInterleaved
                );
                require!(
                    &ix.data[8..] == args_bytes.as_slice(),
                    PocketError::FillInterleaved
                );
                found_end = true;
                break;
            }
            i += 1;
        }
        require!(found_end, PocketError::NoFillEnd);

        // Token accounts: input leaves the pocket, output lands later.
        let pocket_in = parse_token_account(&ctx.accounts.pocket_in_account)?;
        require!(
            pocket_in.owner == pocket_key && pocket_in.mint == args.in_mint,
            PocketError::BadTokenAccount
        );
        let solver_in = parse_token_account(&ctx.accounts.solver_in_account)?;
        require!(solver_in.mint == args.in_mint, PocketError::BadTokenAccount);
        let pocket_out = parse_token_account(&ctx.accounts.pocket_out_account)?;
        require!(
            pocket_out.owner == pocket_key && pocket_out.mint == args.out_mint,
            PocketError::BadTokenAccount
        );

        if let Some(allowed) = non_empty(&pocket.policy.allowed_out_mints) {
            require!(allowed.contains(&args.out_mint), PocketError::OutMintNotAllowed);
        }

        // Value the input in USD through the user-pinned oracle feed.
        let in_feed = pocket
            .policy
            .feed_for(&args.in_mint)
            .ok_or(error!(PocketError::NoInputOracle))?
            .clone();
        let in_price = read_price(
            &ctx.accounts.in_price.to_account_info(),
            &in_feed.feed_id,
            clock.unix_timestamp,
        )?;
        let in_value_usd_e6 = usd_e6(args.in_max, in_feed.decimals, &in_price)?;

        pocket.roll_day(clock.slot);
        require!(
            pocket
                .spent_today_usd_e6
                .checked_add(in_value_usd_e6)
                .ok_or(error!(PocketError::Overflow))?
                <= pocket.policy.daily_cap_usd_e6,
            PocketError::DailyCapExceeded
        );

        // Passkey rules: a P-256 session is passkey-held by construction;
        // a software session stays under the big-action threshold and may
        // not buy oracle-less mints (docs/adr/0001).
        let passkey_signed = pocket.session_kind == SESSION_KIND_P256;
        if !passkey_signed {
            require!(
                in_value_usd_e6 <= pocket.policy.big_action_threshold_usd_e6,
                PocketError::PasskeyRequired
            );
        }
        if pocket.policy.feed_for(&args.out_mint).is_none() {
            require!(
                passkey_signed && in_value_usd_e6 <= pocket.policy.no_oracle_cap_usd_e6,
                PocketError::NoOracleViolation
            );
        }

        let fill = &mut ctx.accounts.fill_state;
        fill.intent_hash = intent_hash;
        fill.in_mint = args.in_mint;
        fill.in_max = args.in_max;
        fill.out_mint = args.out_mint;
        fill.out_min = args.out_min;
        fill.out_balance_before = pocket_out.amount;
        fill.out_account = ctx.accounts.pocket_out_account.key();
        fill.in_value_usd_e6 = in_value_usd_e6;
        fill.passkey_signed = passkey_signed;

        let app_id = pocket.app_id;
        let bump = [pocket.bump];
        let seeds: &[&[u8]] = &[b"pocket", app_id.as_ref(), &bump];
        transfer_from_pocket(
            &ctx.accounts.pocket_in_account.to_account_info(),
            &ctx.accounts.solver_in_account.to_account_info(),
            &pocket.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            args.in_max,
            seeds,
        )?;
        Ok(())
    }

    /// Second half of an atomic fill: the pocket must now hold at least
    /// `out_min` more of the output mint, and that minimum must clear the
    /// oracle slippage floor. Any failure reverts the whole transaction,
    /// fill_begin included.
    pub fn fill_end(ctx: Context<FillEnd>, args: IntentArgs) -> Result<()> {
        require!(get_stack_height() == 1, PocketError::CpiForbidden);
        let pocket_key = ctx.accounts.pocket.key();
        let clock = Clock::get()?;
        let pocket = &mut ctx.accounts.pocket;
        let fill = &ctx.accounts.fill_state;

        let intent = args.to_intent(&pocket_key);
        let intent_hash = hashv(&[&intent.to_bytes()]).to_bytes();
        require!(intent_hash == fill.intent_hash, PocketError::WrongPocket);
        // The delta is only meaningful on the account that was snapshotted.
        require!(
            ctx.accounts.pocket_out_account.key() == fill.out_account,
            PocketError::FillAccountMismatch
        );

        let pocket_out = parse_token_account(&ctx.accounts.pocket_out_account)?;
        require!(
            pocket_out.owner == pocket_key && pocket_out.mint == args.out_mint,
            PocketError::BadTokenAccount
        );
        let received = pocket_out
            .amount
            .checked_sub(fill.out_balance_before)
            .ok_or(error!(PocketError::OutputTooLow))?;
        require!(received >= args.out_min, PocketError::OutputTooLow);

        // Oracle floor: out_min valued at the out feed must cover the
        // input value minus the allowed slippage.
        if let Some(out_feed) = pocket.policy.feed_for(&args.out_mint).cloned() {
            let out_price_info = ctx
                .accounts
                .out_price
                .as_ref()
                .ok_or(error!(PocketError::BadOracle))?
                .to_account_info();
            let out_price = read_price(&out_price_info, &out_feed.feed_id, clock.unix_timestamp)?;
            let out_usd = usd_e6(args.out_min, out_feed.decimals, &out_price)? as u128;
            let floor = (fill.in_value_usd_e6 as u128)
                .checked_mul(10_000u128 - pocket.policy.max_slippage_bps as u128)
                .ok_or(error!(PocketError::Overflow))?;
            require!(out_usd * 10_000 >= floor, PocketError::SlippageFloor);
        }
        // else: fill_begin already enforced the passkey + no-oracle cap.

        pocket.mark_nonce(args.nonce);
        pocket.spent_today_usd_e6 = pocket
            .spent_today_usd_e6
            .checked_add(fill.in_value_usd_e6)
            .ok_or(error!(PocketError::Overflow))?;

        emit!(Filled {
            pocket: pocket_key,
            intent_hash,
            in_mint: args.in_mint,
            in_max: args.in_max,
            out_mint: args.out_mint,
            out_received: received,
            in_value_usd_e6: fill.in_value_usd_e6,
        });
        Ok(())
    }

    /// Moves every balance home. Works with the live session signature or
    /// an owner proof, so it still works after a session is lost or
    /// revoked. Token accounts come as (pocket_ata, home_ata) pairs in
    /// remaining_accounts; surplus lamports on the pocket follow.
    pub fn sweep_home<'info>(
        ctx: Context<'_, '_, 'info, 'info, SweepHome<'info>>,
        auth: SessionOrOwner,
    ) -> Result<()> {
        require!(get_stack_height() == 1, PocketError::CpiForbidden);
        let pocket_key = ctx.accounts.pocket.key();
        require!(
            ctx.accounts.home.key() == ctx.accounts.pocket.home,
            PocketError::HomeMismatch
        );

        let mut digest_input = b"ghostlink:sweep:v1".to_vec();
        digest_input.extend_from_slice(&pocket_key.to_bytes());
        digest_input.extend_from_slice(&ctx.accounts.pocket.owner_action_nonce.to_le_bytes());
        let digest = hashv(&[&digest_input]).to_bytes();
        authorize(&ctx.accounts.pocket, &ctx.accounts.instructions, &ctx.accounts.registry_tree, &auth, &digest)?;
        ctx.accounts.pocket.consume_owner_action()?;

        let pocket = &ctx.accounts.pocket;
        let app_id = pocket.app_id;
        let bump = [pocket.bump];
        let seeds: &[&[u8]] = &[b"pocket", app_id.as_ref(), &bump];

        let rest = ctx.remaining_accounts;
        require!(rest.len() % 2 == 0, PocketError::BadTokenAccount);
        for pair in rest.chunks(2) {
            let src_info = &pair[0];
            let dst_info = &pair[1];
            let src = parse_token_account(src_info)?;
            require!(src.owner == pocket_key, PocketError::BadTokenAccount);
            let dst = parse_token_account(dst_info)?;
            require!(
                dst.owner == pocket.home && dst.mint == src.mint,
                PocketError::BadTokenAccount
            );
            if src.amount > 0 {
                transfer_from_pocket(
                    src_info,
                    dst_info,
                    &pocket.to_account_info(),
                    &ctx.accounts.token_program.to_account_info(),
                    src.amount,
                    seeds,
                )?;
            }
            close_pocket_account(
                src_info,
                &ctx.accounts.home.to_account_info(),
                &pocket.to_account_info(),
                &ctx.accounts.token_program.to_account_info(),
                seeds,
            )?;
        }

        // Surplus lamports (direct SOL deposits) go home too; the rent
        // reserve stays so the pocket account survives.
        let pocket_info = pocket.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(pocket_info.data_len());
        let surplus = pocket_info.lamports().saturating_sub(rent_min);
        if surplus > 0 {
            pocket_info.sub_lamports(surplus)?;
            ctx.accounts.home.add_lamports(surplus)?;
        }

        emit!(SweptHome {
            pocket: pocket_key,
            home: pocket.home,
        });
        Ok(())
    }

    /// Stages a home or policy change behind the 24-hour timelock.
    /// Owner proof only — a session key can never move the exit door.
    pub fn propose_change(
        ctx: Context<OwnerAction>,
        change: Change,
        proof: OwnerProofArgs,
    ) -> Result<()> {
        require!(get_stack_height() == 1, PocketError::CpiForbidden);
        let pocket_key = ctx.accounts.pocket.key();
        require!(ctx.accounts.pocket.pending.is_none(), PocketError::ChangePending);
        if let Change::Policy(p) = &change {
            require!(p.validate(), PocketError::BadPolicy);
        }

        let change_digest = hashv(&[&change.try_to_vec()?]).to_bytes();
        let mut digest_input = b"ghostlink:change:v1".to_vec();
        digest_input.extend_from_slice(&pocket_key.to_bytes());
        digest_input.extend_from_slice(&change_digest);
        digest_input.extend_from_slice(&ctx.accounts.pocket.owner_action_nonce.to_le_bytes());
        let digest = hashv(&[&digest_input]).to_bytes();
        check_owner_proof(&ctx.accounts.pocket, &ctx.accounts.registry_tree, &proof, &digest)?;
        ctx.accounts.pocket.consume_owner_action()?;

        let clock = Clock::get()?;
        let executable_after_slot = clock.slot.saturating_add(TIMELOCK_SLOTS);
        ctx.accounts.pocket.pending = Some(PendingChange {
            change,
            executable_after_slot,
        });
        emit!(ChangeProposed {
            pocket: pocket_key,
            executable_after_slot,
        });
        Ok(())
    }

    /// Applies a staged change once its timelock has elapsed. Anyone may
    /// crank it; the authorization happened at propose time.
    pub fn execute_change(ctx: Context<ExecuteChange>) -> Result<()> {
        require!(get_stack_height() == 1, PocketError::CpiForbidden);
        let pocket = &mut ctx.accounts.pocket;
        let pending = pocket
            .pending
            .take()
            .ok_or(error!(PocketError::NoChangePending))?;
        require!(
            Clock::get()?.slot >= pending.executable_after_slot,
            PocketError::TimelockActive
        );
        match pending.change {
            Change::Home(h) => pocket.home = h,
            Change::Policy(p) => pocket.policy = p,
        }
        pocket.consume_owner_action()?;
        emit!(ChangeExecuted { pocket: pocket.key() });
        Ok(())
    }

    /// Cancels the staged change at any time, with an owner proof bound
    /// to exactly that change.
    pub fn cancel_change(ctx: Context<OwnerAction>, proof: OwnerProofArgs) -> Result<()> {
        require!(get_stack_height() == 1, PocketError::CpiForbidden);
        let pocket_key = ctx.accounts.pocket.key();
        let pending = ctx
            .accounts
            .pocket
            .pending
            .as_ref()
            .ok_or(error!(PocketError::NoChangePending))?;

        let change_digest = hashv(&[&pending.change.try_to_vec()?]).to_bytes();
        let mut digest_input = b"ghostlink:cancel:v1".to_vec();
        digest_input.extend_from_slice(&pocket_key.to_bytes());
        digest_input.extend_from_slice(&change_digest);
        digest_input.extend_from_slice(&ctx.accounts.pocket.owner_action_nonce.to_le_bytes());
        let digest = hashv(&[&digest_input]).to_bytes();
        check_owner_proof(&ctx.accounts.pocket, &ctx.accounts.registry_tree, &proof, &digest)?;
        ctx.accounts.pocket.consume_owner_action()?;

        ctx.accounts.pocket.pending = None;
        emit!(ChangeCanceled { pocket: pocket_key });
        Ok(())
    }

    /// Ends the session immediately. Session signature or owner proof.
    pub fn revoke_session(ctx: Context<Revoke>, auth: SessionOrOwner) -> Result<()> {
        require!(get_stack_height() == 1, PocketError::CpiForbidden);
        let pocket_key = ctx.accounts.pocket.key();
        let mut digest_input = b"ghostlink:revoke:v1".to_vec();
        digest_input.extend_from_slice(&pocket_key.to_bytes());
        digest_input.extend_from_slice(&ctx.accounts.pocket.owner_action_nonce.to_le_bytes());
        let digest = hashv(&[&digest_input]).to_bytes();
        authorize(&ctx.accounts.pocket, &ctx.accounts.instructions, &ctx.accounts.registry_tree, &auth, &digest)?;
        ctx.accounts.pocket.consume_owner_action()?;

        ctx.accounts.pocket.session_expiry_slot = 0;
        emit!(SessionRevoked { pocket: pocket_key });
        Ok(())
    }
}

/// None when the policy's allowed list is empty (meaning: any mint).
fn non_empty(v: &[Pubkey]) -> Option<&[Pubkey]> {
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// Validates a registry/census TreeState account (owner program, PDA
/// address, layout) and requires `root` to be in its history ring.
fn check_tree_account(
    info: &UncheckedAccount,
    owner_program: &Pubkey,
    seed: &[u8],
    root: &[u8; 32],
    err: PocketError,
) -> Result<()> {
    require!(info.owner == owner_program, PocketError::BadTokenAccount);
    let (expected, _) = Pubkey::find_program_address(&[seed], owner_program);
    require!(info.key() == expected, PocketError::BadTokenAccount);
    let data = info.try_borrow_data()?;
    if !tree_account::ring_contains(&data, root) {
        return Err(err.into());
    }
    Ok(())
}

/// Owner proof: binds registry membership, this pocket's domain and
/// app_id, and the exact action digest (reduced into the field).
fn check_owner_proof(
    pocket: &Account<Pocket>,
    registry_tree: &UncheckedAccount,
    proof: &OwnerProofArgs,
    action_digest: &[u8; 32],
) -> Result<()> {
    require!(is_in_field(&proof.registry_root), PocketError::NotInField);
    check_tree_account(
        registry_tree,
        &REGISTRY_PROGRAM_ID,
        b"tree",
        &proof.registry_root,
        PocketError::UnknownRegistryRoot,
    )?;
    let public_inputs: [[u8; 32]; 4] = [
        proof.registry_root,
        pocket.domain_hash,
        pocket.app_id,
        reduce_to_field(action_digest),
    ];
    verify_owner(&proof.proof_a, &proof.proof_b, &proof.proof_c, &public_inputs)
        .map_err(|_| error!(PocketError::ProofInvalid))
}

/// Session-or-owner authorization for sweep and revoke.
fn authorize(
    pocket: &Account<Pocket>,
    instructions: &UncheckedAccount,
    registry_tree: &UncheckedAccount,
    auth: &SessionOrOwner,
    digest: &[u8; 32],
) -> Result<()> {
    match auth {
        SessionOrOwner::Session { webauthn } => {
            require!(
                Clock::get()?.slot < pocket.session_expiry_slot,
                PocketError::SessionExpired
            );
            let ixs = instructions.to_account_info();
            let current = load_current_index_checked(&ixs)? as usize;
            require!(current > 0, PocketError::MissingSignature);
            let pre = load_instruction_at_checked(current - 1, &ixs)?;
            check_session_signature(
                &pre,
                (current - 1) as u16,
                pocket.session_kind,
                &pocket.session_key,
                digest,
                webauthn.as_ref(),
            )
        }
        SessionOrOwner::Owner(proof) => check_owner_proof(pocket, registry_tree, proof, digest),
    }
}

#[derive(Accounts)]
#[instruction(args: OpenSessionArgs)]
pub struct OpenSession<'info> {
    /// The relayer: pays fees and rent, carries no other authority.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Pocket::INIT_SPACE,
        seeds = [b"pocket", args.app_id.as_ref()],
        bump
    )]
    pub pocket: Account<'info, Pocket>,
    /// CHECK: owner program, PDA address and layout verified in handler.
    pub registry_tree: UncheckedAccount<'info>,
    /// CHECK: owner program, PDA address and layout verified in handler.
    pub census_tree: UncheckedAccount<'info>,
    /// CHECK: constrained to the instructions sysvar address.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: IntentArgs)]
pub struct FillBegin<'info> {
    #[account(mut)]
    pub solver: Signer<'info>,
    #[account(mut, seeds = [b"pocket", pocket.app_id.as_ref()], bump = pocket.bump)]
    pub pocket: Account<'info, Pocket>,
    /// CHECK: parsed and owner/mint-checked in handler.
    #[account(mut)]
    pub pocket_in_account: UncheckedAccount<'info>,
    /// CHECK: parsed and mint-checked in handler; the solver picks it.
    #[account(mut)]
    pub solver_in_account: UncheckedAccount<'info>,
    /// CHECK: parsed and owner/mint-checked in handler (balance snapshot).
    pub pocket_out_account: UncheckedAccount<'info>,
    /// CHECK: Pyth price update, owner- and feed-checked in handler.
    pub in_price: UncheckedAccount<'info>,
    #[account(
        init,
        payer = solver,
        space = 8 + FillState::INIT_SPACE,
        seeds = [b"fill", pocket.key().as_ref(), &args.nonce.to_le_bytes()],
        bump
    )]
    pub fill_state: Account<'info, FillState>,
    /// CHECK: must be the SPL Token program (token.rs enforces).
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: constrained to the instructions sysvar address.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: IntentArgs)]
pub struct FillEnd<'info> {
    #[account(mut)]
    pub solver: Signer<'info>,
    #[account(mut, seeds = [b"pocket", pocket.app_id.as_ref()], bump = pocket.bump)]
    pub pocket: Account<'info, Pocket>,
    #[account(
        mut,
        close = solver,
        seeds = [b"fill", pocket.key().as_ref(), &args.nonce.to_le_bytes()],
        bump
    )]
    pub fill_state: Account<'info, FillState>,
    /// CHECK: parsed and owner/mint-checked in handler.
    pub pocket_out_account: UncheckedAccount<'info>,
    /// CHECK: Pyth price update for the output mint, when the policy
    /// binds one; owner- and feed-checked in handler.
    pub out_price: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct SweepHome<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"pocket", pocket.app_id.as_ref()], bump = pocket.bump)]
    pub pocket: Account<'info, Pocket>,
    /// CHECK: must equal pocket.home (verified in handler); receives
    /// closed-account rent and surplus lamports.
    #[account(mut)]
    pub home: UncheckedAccount<'info>,
    /// CHECK: validated when the owner-proof path is taken.
    pub registry_tree: UncheckedAccount<'info>,
    /// CHECK: must be the SPL Token program (token.rs enforces).
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: constrained to the instructions sysvar address.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OwnerAction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"pocket", pocket.app_id.as_ref()], bump = pocket.bump)]
    pub pocket: Account<'info, Pocket>,
    /// CHECK: owner program, PDA address and layout verified in handler.
    pub registry_tree: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ExecuteChange<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"pocket", pocket.app_id.as_ref()], bump = pocket.bump)]
    pub pocket: Account<'info, Pocket>,
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"pocket", pocket.app_id.as_ref()], bump = pocket.bump)]
    pub pocket: Account<'info, Pocket>,
    /// CHECK: validated when the owner-proof path is taken.
    pub registry_tree: UncheckedAccount<'info>,
    /// CHECK: constrained to the instructions sysvar address.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}
