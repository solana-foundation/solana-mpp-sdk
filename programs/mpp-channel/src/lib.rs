use anchor_lang::prelude::*;

pub mod jcs_voucher;
pub mod ed25519;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use instructions::close::*;
pub use instructions::open::*;
pub use instructions::request_close::*;
pub use instructions::settle::*;
pub use instructions::top_up::*;
pub use instructions::withdraw::*;

declare_id!("21fLdahqKtVAt4V2JLwVrRb7tuqPADjjPVCU9bK3MFPQ");

#[program]
pub mod mpp_channel {
    use super::*;

    pub fn open(
        ctx: Context<Open>,
        salt: u64,
        deposit: u64,
        grace_period_seconds: u64,
        authorized_signer: Pubkey,
    ) -> Result<()> {
        crate::instructions::open::handler(ctx, salt, deposit, grace_period_seconds, authorized_signer)
    }

    pub fn settle(ctx: Context<Settle>, args: SettleArgs) -> Result<()> {
        crate::instructions::settle::handler(ctx, args)
    }

    pub fn close(ctx: Context<Close>, args: SettleArgs) -> Result<()> {
        crate::instructions::close::handler(ctx, args)
    }

    pub fn top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
        crate::instructions::top_up::handler(ctx, amount)
    }

    pub fn request_close(ctx: Context<RequestClose>) -> Result<()> {
        crate::instructions::request_close::handler(ctx)
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        crate::instructions::withdraw::handler(ctx)
    }
}
