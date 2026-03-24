use anchor_lang::prelude::*;

#[event]
pub struct ChannelOpened {
    pub channel: Pubkey,
    pub payer: Pubkey,
    pub payee: Pubkey,
    pub token: Pubkey,
    pub authorized_signer: Pubkey,
    pub deposit: u64,
    pub grace_period_seconds: u64,
}

#[event]
pub struct ChannelSettled {
    pub channel: Pubkey,
    pub delta: u64,
    pub cumulative_settled: u64,
}

#[event]
pub struct ChannelClosed {
    pub channel: Pubkey,
    pub final_settled: u64,
    pub refund: u64,
}

#[event]
pub struct CloseRequested {
    pub channel: Pubkey,
    pub requested_at: i64,
}

#[event]
pub struct TopUpCompleted {
    pub channel: Pubkey,
    pub additional: u64,
    pub new_deposit: u64,
}

#[event]
pub struct Withdrawn {
    pub channel: Pubkey,
    pub refund: u64,
}
