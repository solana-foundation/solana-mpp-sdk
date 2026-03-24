use anchor_lang::prelude::*;

pub const CHANNEL_SEED: &[u8] = b"mpp-channel";
pub const CHANNEL_VAULT_SEED: &[u8] = b"mpp-channel-vault";

/// On-chain payment channel account.
///
/// Tracks escrowed funds between a payer and payee. The payer deposits
/// SPL tokens at open time. The payee can settle partial amounts using
/// signed vouchers. Either party can close the channel: the payee via
/// cooperative close, the payer via requestClose + grace period + withdraw.
#[account]
pub struct PaymentChannel {
    /// The wallet that deposited funds into this channel.
    pub payer: Pubkey,
    /// The wallet authorized to settle and close the channel.
    pub payee: Pubkey,
    /// The SPL token mint. Native SOL is not currently supported — all channels
    /// use SPL tokens via transfer_checked and ATA-backed vaults.
    /// TODO: add a separate native SOL path (wrapping or system-program transfer).
    pub token: Pubkey,
    /// The key permitted to sign vouchers. Equals payer unless delegated.
    pub authorized_signer: Pubkey,
    /// Total amount deposited (in token base units).
    pub deposit: u64,
    /// Cumulative amount already transferred to payee via settle/close.
    pub settled: u64,
    /// Unix timestamp when forced close was requested (0 if none).
    pub close_requested_at: i64,
    /// Grace period in seconds before payer can withdraw after requestClose.
    pub grace_period_seconds: u64,
    /// Whether the channel has been finalized (closed).
    pub finalized: bool,
    /// Client-chosen salt used as a PDA seed. Allows the same payer/payee
    /// pair to open multiple channels.
    pub salt: u64,
    /// PDA bump seed.
    pub bump: u8,
}

impl PaymentChannel {
    /// Account size: 8-byte discriminator + all fields.
    /// 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 8 + 1 = 170
    pub const SIZE: usize = 8 + 170;

    pub fn is_open(&self) -> bool {
        !self.finalized
    }
}
