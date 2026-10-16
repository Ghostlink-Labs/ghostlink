//! Test-only CPI caller (never deployed). `forward` re-issues whatever
//! instruction it is handed to the target program via `invoke`, carrying
//! the original accounts and signer flags. The integration tests use it
//! to prove that every state-changing GhostLink instruction refuses to run
//! under another program (`get_stack_height() == 1`), which is what keeps
//! signature-precompile introspection honest.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;

declare_id!("GnAug2mhW6HavrtFSPWa3ikA4PmGibzBmUgk9Lq21tjk");

#[program]
pub mod ghostlink_cpi_caller {
    use super::*;

    pub fn forward(ctx: Context<Forward>, data: Vec<u8>) -> Result<()> {
        let accounts = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: a.key(),
                is_signer: a.is_signer,
                is_writable: a.is_writable,
            })
            .collect();
        let ix = Instruction {
            program_id: ctx.accounts.target.key(),
            accounts,
            data,
        };
        invoke(&ix, ctx.remaining_accounts).map_err(Into::into)
    }
}

#[derive(Accounts)]
pub struct Forward<'info> {
    /// CHECK: whichever program the test wants to call through CPI.
    pub target: UncheckedAccount<'info>,
}
