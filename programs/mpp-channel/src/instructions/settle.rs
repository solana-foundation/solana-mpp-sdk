use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::jcs_voucher::{parse_jcs_voucher_message, verify_channel_id};
use crate::ed25519::validate_ed25519_instruction;
use crate::errors::MppChannelError;
use crate::events::ChannelSettled;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SettleArgs {
    pub cumulative_amount: u64,
    pub voucher_message: Vec<u8>,
    pub ed25519_instruction_index: u8,
}

#[derive(Accounts)]
pub struct Settle<'info> {
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

    /// CHECK: Validated by address constraint.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Settle>, args: SettleArgs) -> Result<()> {
    let channel = &ctx.accounts.channel;

    require!(!channel.finalized, MppChannelError::ChannelFinalized);

    require!(
        args.cumulative_amount > channel.settled,
        MppChannelError::AmountNotGreaterThanSettled
    );

    require!(
        args.cumulative_amount <= channel.deposit,
        MppChannelError::AmountExceedsDeposit
    );

    // Validate the Ed25519 instruction verified the voucher message
    // with the channel's authorized signer.
    validate_ed25519_instruction(
        &ctx.accounts.instructions_sysvar,
        &channel.authorized_signer,
        &args.voucher_message,
        args.ed25519_instruction_index,
    )?;

    // Parse the JCS voucher message and verify channelId and cumulativeAmount.
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

    // Transfer delta from vault to payee.
    let delta = args
        .cumulative_amount
        .checked_sub(channel.settled)
        .ok_or(MppChannelError::ArithmeticOverflow)?;

    if delta > 0 {
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

    let channel = &mut ctx.accounts.channel;
    channel.settled = args.cumulative_amount;

    emit!(ChannelSettled {
        channel: channel.key(),
        delta,
        cumulative_settled: channel.settled,
    });

    Ok(())
}
