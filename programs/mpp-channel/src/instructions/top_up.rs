use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::errors::MppChannelError;
use crate::events::TopUpCompleted;
use crate::state::*;

#[derive(Accounts)]
pub struct TopUp<'info> {
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

pub fn handler(ctx: Context<TopUp>, amount: u64) -> Result<()> {
    let channel = &ctx.accounts.channel;

    require!(!channel.finalized, MppChannelError::ChannelFinalized);
    require!(amount > 0, MppChannelError::ZeroDeposit);

    let transfer_accounts = TransferChecked {
        from: ctx.accounts.payer_token_account.to_account_info(),
        mint: ctx.accounts.token.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.payer.to_account_info(),
    };
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.key(),
        transfer_accounts,
    );
    token_interface::transfer_checked(transfer_ctx, amount, ctx.accounts.token.decimals)?;

    let channel = &mut ctx.accounts.channel;
    channel.deposit = channel
        .deposit
        .checked_add(amount)
        .ok_or(MppChannelError::ArithmeticOverflow)?;
    channel.close_requested_at = 0;

    emit!(TopUpCompleted {
        channel: channel.key(),
        additional: amount,
        new_deposit: channel.deposit,
    });

    Ok(())
}
