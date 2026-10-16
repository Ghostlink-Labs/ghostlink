//! GhostLink registry program.
//!
//! In plain language: this program keeps the one-time register of wallets.
//! A wallet signs a single message committing to a secret it will never
//! reveal; the program checks that signature really happened (through
//! Solana's Ed25519 precompile, inspected instruction-by-instruction) and
//! appends one leaf to an append-only Merkle tree. There is no update, no
//! delete, and no admin — a wallet that wants a new secret uses a new
//! wallet.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use ghostlink_verifier::encoding::is_in_field;
use ghostlink_verifier::merkle::{Frontier, RootRing, ROOT_HISTORY, TREE_DEPTH};
use ghostlink_verifier::poseidon;

declare_id!("54EZ5ZkUANBs1SfQoXaU5EQSR8VAaD3XDtKEZGp6KjRv");

/// Cluster tag bound into every registration message, fixed per build so
/// a message signed for devnet can never register on mainnet.
#[cfg(feature = "mainnet")]
pub const CLUSTER: &str = "mainnet-beta";
#[cfg(not(feature = "mainnet"))]
pub const CLUSTER: &str = "devnet";

pub const REGISTER_TAG: &str = "ghostlink:register:v1";

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

#[program]
pub mod ghostlink_registry {
    use super::*;

    /// Creates the tree state. Called once; the deployer has no further
    /// powers afterwards — nothing about the caller is stored.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let mut tree = ctx.accounts.tree_state.load_init()?;
        tree.roots[0] = ghostlink_verifier::merkle::empty_root();
        Ok(())
    }

    /// Registers a wallet's commitment. The relayer pays; the wallet's
    /// consent is the Ed25519-precompile-verified signature over the
    /// canonical registration message in this same transaction.
    pub fn register(ctx: Context<Register>, commitment: [u8; 32]) -> Result<()> {
        require!(is_in_field(&commitment), RegistryError::NotInField);
        require!(get_stack_height() == 1, RegistryError::CpiForbidden);

        // The instruction immediately before this one must be the Ed25519
        // precompile verifying exactly (wallet, canonical message).
        let ixs = ctx.accounts.instructions.to_account_info();
        let current = load_current_index_checked(&ixs)? as usize;
        require!(current > 0, RegistryError::MissingSignature);
        let pre = load_instruction_at_checked(current - 1, &ixs)?;
        require!(
            pre.program_id == ED25519_PROGRAM_ID,
            RegistryError::MissingSignature
        );

        let message = canonical_message(&commitment, &ctx.accounts.wallet.key(), &crate::ID);
        verify_ed25519_ix(
            &pre.data,
            (current - 1) as u16,
            &ctx.accounts.wallet.key().to_bytes(),
            &message,
        )?;

        // Append L_reg = Poseidon(pk_hi, pk_lo, C).
        let leaf = poseidon::registry_leaf(&ctx.accounts.wallet.key().to_bytes(), &commitment)
            .map_err(|_| error!(RegistryError::HashFailed))?;

        let mut tree = ctx.accounts.tree_state.load_mut()?;
        let tree_ref = &mut *tree;
        let leaf_index = tree_ref.next_index;
        let root = Frontier {
            next_index: &mut tree_ref.next_index,
            frontier: &mut tree_ref.frontier,
        }
        .append(leaf)
        .map_err(|_| error!(RegistryError::TreeFull))?;
        RootRing {
            roots: &mut tree_ref.roots,
            cursor: &mut tree_ref.root_cursor,
        }
        .push(root);

        let binding = &mut ctx.accounts.binding;
        binding.leaf_index = leaf_index;
        binding.commitment = commitment;
        binding.slot = Clock::get()?.slot;

        emit!(Registered {
            leaf_index,
            leaf,
            root,
            wallet: ctx.accounts.wallet.key(),
            commitment,
        });
        Ok(())
    }
}

/// The canonical ASCII registration message (mirrors
/// `packages/common/src/registration.ts`, vector-tested):
///
/// ```text
/// ghostlink:register:v1
/// commitment:<64 hex>
/// wallet:<base58>
/// program:<base58>
/// cluster:<CLUSTER>
/// ```
pub fn canonical_message(commitment: &[u8; 32], wallet: &Pubkey, program: &Pubkey) -> Vec<u8> {
    let mut hexc = String::with_capacity(64);
    for b in commitment {
        use core::fmt::Write;
        let _ = write!(hexc, "{b:02x}");
    }
    format!(
        "{REGISTER_TAG}\ncommitment:{hexc}\nwallet:{}\nprogram:{}\ncluster:{CLUSTER}",
        bs58::encode(wallet.to_bytes()).into_string(),
        bs58::encode(program.to_bytes()).into_string(),
    )
    .into_bytes()
}

/// Wraps a message in the Solana off-chain message signing envelope
/// (version 0, format 0) the way Ledger does.
pub fn framed_message(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 4 + message.len());
    out.push(0xff);
    out.extend_from_slice(b"solana offchain");
    out.push(0); // header version
    out.push(0); // message format
    out.extend_from_slice(&(message.len() as u16).to_le_bytes());
    out.extend_from_slice(message);
    out
}

/// Strict Ed25519 precompile payload check: exactly one signature, every
/// offset pointing into the precompile instruction itself (never another
/// instruction), the pubkey equal to `expected_pubkey`, and the message
/// equal to the canonical bytes or their off-chain-framed form. Checking
/// program id, pubkey, message bytes — not merely that a precompile
/// exists — is the fake-precompile control in the threat model.
pub fn verify_ed25519_ix(
    data: &[u8],
    own_index: u16,
    expected_pubkey: &[u8; 32],
    expected_message: &[u8],
) -> Result<()> {
    // Layout: count u8, padding u8, then per-signature offsets:
    // sig_off u16, sig_ix u16, pk_off u16, pk_ix u16, msg_off u16,
    // msg_len u16, msg_ix u16 (14 bytes).
    require!(data.len() >= 2 + 14, RegistryError::BadSignatureInstruction);
    require!(data[0] == 1, RegistryError::BadSignatureInstruction);

    let u16at = |i: usize| -> u16 { u16::from_le_bytes([data[i], data[i + 1]]) };
    let sig_off = u16at(2) as usize;
    let sig_ix = u16at(4);
    let pk_off = u16at(6) as usize;
    let pk_ix = u16at(8);
    let msg_off = u16at(10) as usize;
    let msg_len = u16at(12) as usize;
    let msg_ix = u16at(14);

    // All references must stay inside this very instruction.
    for ix_ref in [sig_ix, pk_ix, msg_ix] {
        require!(
            ix_ref == u16::MAX || ix_ref == own_index,
            RegistryError::BadSignatureInstruction
        );
    }
    require!(
        pk_off + 32 <= data.len() && sig_off + 64 <= data.len() && msg_off + msg_len <= data.len(),
        RegistryError::BadSignatureInstruction
    );
    require!(
        &data[pk_off..pk_off + 32] == expected_pubkey,
        RegistryError::WrongWallet
    );

    let msg = &data[msg_off..msg_off + msg_len];
    let framed = framed_message(expected_message);
    require!(
        msg == expected_message || msg == framed.as_slice(),
        RegistryError::WrongMessage
    );
    Ok(())
}

#[account(zero_copy)]
#[repr(C)]
pub struct TreeState {
    pub next_index: u64,
    pub frontier: [[u8; 32]; TREE_DEPTH],
    pub roots: [[u8; 32]; ROOT_HISTORY],
    pub root_cursor: u8,
    pub _padding: [u8; 7],
}

impl TreeState {
    pub const SIZE: usize = 8 + 8 + 32 * TREE_DEPTH + 32 * ROOT_HISTORY + 1 + 7;
}

#[account]
#[derive(InitSpace)]
pub struct Binding {
    pub leaf_index: u64,
    pub commitment: [u8; 32],
    pub slot: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = TreeState::SIZE,
        seeds = [b"tree"],
        bump
    )]
    pub tree_state: AccountLoader<'info, TreeState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    /// The relayer: pays fees and rent, carries no other authority.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: not a signer — consent is the precompile-verified signature
    /// this instruction demands over the canonical message naming this key.
    pub wallet: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Binding::INIT_SPACE,
        seeds = [b"binding", wallet.key().as_ref()],
        bump
    )]
    pub binding: Account<'info, Binding>,
    #[account(mut, seeds = [b"tree"], bump)]
    pub tree_state: AccountLoader<'info, TreeState>,
    /// CHECK: constrained to the instructions sysvar address.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct Registered {
    pub leaf_index: u64,
    pub leaf: [u8; 32],
    pub root: [u8; 32],
    pub wallet: Pubkey,
    pub commitment: [u8; 32],
}

#[error_code]
pub enum RegistryError {
    #[msg("value is not a reduced BN254 field element")]
    NotInField,
    #[msg("register must be a top-level instruction")]
    CpiForbidden,
    #[msg("no Ed25519 precompile instruction immediately before register")]
    MissingSignature,
    #[msg("malformed Ed25519 precompile payload")]
    BadSignatureInstruction,
    #[msg("precompile verified a different wallet")]
    WrongWallet,
    #[msg("precompile verified a different message")]
    WrongMessage,
    #[msg("Poseidon hash failed")]
    HashFailed,
    #[msg("registry tree is full")]
    TreeFull,
}
