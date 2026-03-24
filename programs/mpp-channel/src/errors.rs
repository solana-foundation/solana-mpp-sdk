use anchor_lang::prelude::*;

#[error_code]
pub enum MppChannelError {
    #[msg("Channel is not open (finalized)")]
    ChannelNotOpen,
    #[msg("Channel is already finalized")]
    ChannelFinalized,
    #[msg("Cumulative amount must exceed current settled amount")]
    AmountNotGreaterThanSettled,
    #[msg("Cumulative amount exceeds deposit")]
    AmountExceedsDeposit,
    #[msg("Missing Ed25519 verify instruction")]
    MissingEd25519Instruction,
    #[msg("Ed25519 instruction targets wrong program")]
    InvalidEd25519Program,
    #[msg("Ed25519 instruction verifies wrong public key")]
    InvalidEd25519PublicKey,
    #[msg("Ed25519 instruction verifies wrong message")]
    InvalidEd25519Message,
    #[msg("Unauthorized: caller is not the payer")]
    UnauthorizedPayer,
    #[msg("Unauthorized: caller is not the payee")]
    UnauthorizedPayee,
    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Close has not been requested")]
    CloseNotRequested,
    #[msg("Grace period has not expired yet")]
    GracePeriodNotExpired,
    #[msg("Close has already been requested")]
    CloseAlreadyRequested,
}
