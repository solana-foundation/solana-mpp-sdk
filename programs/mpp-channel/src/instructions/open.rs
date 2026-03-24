use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::errors::MppChannelError;
use crate::events::ChannelOpened;
use crate::state::*;

#[derive(Accounts)]
#[instruction(salt: u64, _deposit: u64, _grace_period_seconds: u64, authorized_signer: Pubkey)]
pub struct Open<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Any valid pubkey can be a payee.
    pub payee: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = PaymentChannel::SIZE,
        seeds = [
            CHANNEL_SEED,
            payer.key().as_ref(),
            payee.key().as_ref(),
            mint.key().as_ref(),
            &salt.to_le_bytes(),
            authorized_signer.as_ref(),
        ],
        bump,
    )]
    pub channel: Account<'info, PaymentChannel>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = payer,
    )]
    pub payer_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = channel,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Open>,
    salt: u64,
    deposit: u64,
    grace_period_seconds: u64,
    authorized_signer: Pubkey,
) -> Result<()> {
    require!(deposit > 0, MppChannelError::ZeroDeposit);

    let channel = &mut ctx.accounts.channel;
    channel.payer = ctx.accounts.payer.key();
    channel.payee = ctx.accounts.payee.key();
    channel.token = ctx.accounts.mint.key();
    channel.authorized_signer = authorized_signer;
    channel.deposit = deposit;
    channel.settled = 0;
    channel.close_requested_at = 0;
    channel.grace_period_seconds = grace_period_seconds;
    channel.finalized = false;
    channel.salt = salt;
    channel.bump = ctx.bumps.channel;

    let transfer_accounts = TransferChecked {
        from: ctx.accounts.payer_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.payer.to_account_info(),
    };
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.key(),
        transfer_accounts,
    );
    token_interface::transfer_checked(transfer_ctx, deposit, ctx.accounts.mint.decimals)?;

    emit!(ChannelOpened {
        channel: channel.key(),
        payer: channel.payer,
        payee: channel.payee,
        token: channel.token,
        authorized_signer: channel.authorized_signer,
        deposit,
        grace_period_seconds,
    });

    Ok(())
}
