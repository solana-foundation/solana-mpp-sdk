//! Channel PDA derivation.
//!
//! The on-chain payment-channels program stores per-channel state under a
//! Program Derived Address (PDA) keyed by the participants, the mint, the
//! authorized off-chain signer, and a caller-supplied salt. The seed order
//! defined here MUST match the program's expected derivation byte-for-byte;
//! a divergence makes `open` create an account the program cannot rediscover
//! on subsequent calls.
//!
//! `Pubkey::find_program_address` performs the bump search and returns the
//! canonical (PDA, bump) pair, where the bump is the largest `u8` such that
//! the seeds plus the bump produce a non-curve address.

use solana_pubkey::Pubkey;

/// Channel PDA seeds: `[b"channel", payer, payee, mint, authorized_signer, salt_le]`.
///
/// Returns the seed slices in the exact order the on-chain program consumes
/// them. `salt_le_bytes` is the little-endian encoding of the channel salt.
pub fn channel_seeds<'a>(
    payer: &'a Pubkey,
    payee: &'a Pubkey,
    mint: &'a Pubkey,
    authorized_signer: &'a Pubkey,
    salt_le_bytes: &'a [u8; 8],
) -> [&'a [u8]; 6] {
    [
        b"channel",
        payer.as_ref(),
        payee.as_ref(),
        mint.as_ref(),
        authorized_signer.as_ref(),
        salt_le_bytes.as_ref(),
    ]
}

/// Derive the canonical `(PDA, bump)` for a channel.
///
/// Encodes `salt` as little-endian bytes, builds the seed array via
/// [`channel_seeds`], and runs `Pubkey::find_program_address` against
/// `program_id` to find the canonical bump.
pub fn find_channel_pda(
    payer: &Pubkey,
    payee: &Pubkey,
    mint: &Pubkey,
    authorized_signer: &Pubkey,
    salt: u64,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    let salt_le = salt.to_le_bytes();
    let seeds = channel_seeds(payer, payee, mint, authorized_signer, &salt_le);
    Pubkey::find_program_address(&seeds, program_id)
}
