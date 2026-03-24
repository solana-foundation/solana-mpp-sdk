use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::jcs_voucher::{parse_jcs_voucher_message, verify_channel_id};
use crate::ed25519::validate_ed25519_instruction;
use crate::errors::MppChannelError;
use crate::events::ChannelClosed;
use crate::state::*;

use super::settle::SettleArgs;

#[derive(Accounts)]
pub struct Close<'info> {
    pub payee: Signer<'info>,

    #[account(
        mut,
        has_one = payee @ MppChannelError::UnauthorizedPayee,
        has_one = token @ MppChannelError::UnauthorizedPayee,
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
        token::authority = payee,
    )]
    pub payee_token_account: InterfaceAccount<'info, TokenAccount>,

    /// The payer's token account to receive the refund.
    #[account(
        mut,
        token::mint = token,
        constraint = payer_token_account.owner == channel.payer @ MppChannelError::UnauthorizedPayer,
    )]
    pub payer_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Validated by address constraint.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Close>, args: SettleArgs) -> Result<()> {
    let channel = &ctx.accounts.channel;

    require!(!channel.finalized, MppChannelError::ChannelFinalized);

    let final_settled = if !args.voucher_message.is_empty() {
        // Voucher provided: verify signature and settle final delta.
        require!(
            args.cumulative_amount > channel.settled,
            MppChannelError::AmountNotGreaterThanSettled
        );

        require!(
            args.cumulative_amount <= channel.deposit,
            MppChannelError::AmountExceedsDeposit
        );

        validate_ed25519_instruction(
            &ctx.accounts.instructions_sysvar,
            &channel.authorized_signer,
            &args.voucher_message,
            args.ed25519_instruction_index,
        )?;

        let parsed = parse_jcs_voucher_message(&args.voucher_message)
            .ok_or(MppChannelError::InvalidEd25519Message)?;

        require!(
            verify_channel_id(&parsed.channel_id_bytes, &channel.key()),
            MppChannelError::InvalidEd25519Message
        );

        require!(
            parsed.cumulative_amount == args.cumulative_amount,
            MppChannelError::InvalidEd25519Message
        );

        args.cumulative_amount
    } else {
        // No voucher: cooperative refund-only close. Use current settled amount.
        channel.settled
    };

    let delta = final_settled
        .checked_sub(channel.settled)
        .ok_or(MppChannelError::ArithmeticOverflow)?;
    let refund = channel
        .deposit
        .checked_sub(final_settled)
        .ok_or(MppChannelError::ArithmeticOverflow)?;

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

    if delta > 0 {
        let transfer_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.token.to_account_info(),
            to: ctx.accounts.payee_token_account.to_account_info(),
            authority: ctx.accounts.channel.to_account_info(),
        };
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            transfer_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(transfer_ctx, delta, ctx.accounts.token.decimals)?;
    }

    if refund > 0 {
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
    channel.settled = final_settled;
    channel.finalized = true;

    emit!(ChannelClosed {
        channel: channel.key(),
        final_settled,
        refund,
    });

    Ok(())
}
