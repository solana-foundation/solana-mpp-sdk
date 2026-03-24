use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::errors::MppChannelError;
use crate::events::Withdrawn;
use crate::state::*;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub payer: Signer<'info>,

    #[account(
        mut,
        has_one = payer @ MppChannelError::UnauthorizedPayer,
        has_one = token @ MppChannelError::UnauthorizedPayer,
    )]
    pub channel: Account<'info, PaymentChannel>,

    #[account(address = channel.token)]
    pub token: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = token,
        token::authority = channel,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = token,
        token::authority = payer,
    )]
    pub payer_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Withdraw>) -> Result<()> {
    let channel = &ctx.accounts.channel;

    require!(!channel.finalized, MppChannelError::ChannelFinalized);
    require!(
        channel.close_requested_at > 0,
        MppChannelError::CloseNotRequested
    );

    let clock = Clock::get()?;
    let grace_end = channel
        .close_requested_at
        .checked_add(channel.grace_period_seconds as i64)
        .ok_or(MppChannelError::ArithmeticOverflow)?;

    require!(
        clock.unix_timestamp >= grace_end,
        MppChannelError::GracePeriodNotExpired
    );

    let refund = channel
        .deposit
        .checked_sub(channel.settled)
        .ok_or(MppChannelError::ArithmeticOverflow)?;

    if refund > 0 {
        let salt_bytes = channel.salt.to_le_bytes();
        let seeds: &[&[u8]] = &[
            CHANNEL_SEED,
            channel.payer.as_ref(),
            channel.payee.as_ref(),
            channel.token.as_ref(),
            &salt_bytes,
            channel.authorized_signer.as_ref(),
            &[channel.bump],
        ];
        let signer_seeds = &[seeds];

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.token.to_account_info(),
            to: ctx.accounts.payer_token_account.to_account_info(),
            authority: ctx.accounts.channel.to_account_info(),
        };
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            transfer_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(transfer_ctx, refund, ctx.accounts.token.decimals)?;
    }

    let channel = &mut ctx.accounts.channel;
    channel.finalized = true;

    emit!(Withdrawn {
        channel: channel.key(),
        refund,
    });

    Ok(())
}
