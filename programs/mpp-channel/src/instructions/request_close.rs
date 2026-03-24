use anchor_lang::prelude::*;

use crate::errors::MppChannelError;
use crate::events::CloseRequested;
use crate::state::*;

#[derive(Accounts)]
pub struct RequestClose<'info> {
    pub payer: Signer<'info>,

    #[account(
        mut,
        has_one = payer @ MppChannelError::UnauthorizedPayer,
    )]
    pub channel: Account<'info, PaymentChannel>,
}

pub fn handler(ctx: Context<RequestClose>) -> Result<()> {
    let channel = &mut ctx.accounts.channel;

    require!(!channel.finalized, MppChannelError::ChannelFinalized);
    require!(
        channel.close_requested_at == 0,
        MppChannelError::CloseAlreadyRequested
    );

    let clock = Clock::get()?;
    channel.close_requested_at = clock.unix_timestamp;

    emit!(CloseRequested {
        channel: channel.key(),
        requested_at: channel.close_requested_at,
    });

    Ok(())
}
