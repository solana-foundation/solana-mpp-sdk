//! Voucher signed-payload builder (Contract 1).
//!
//! This module owns the 48-byte payload the authorized signer signs over for
//! `settle` / `settleAndFinalize`. The on-chain layout is:
//! `channel_id (32 bytes, raw) || cumulative_amount (u64 LE) || expires_at
//! (i64 LE)`, totalling [`VOUCHER_PAYLOAD_SIZE`] bytes. An `expires_at` of
//! `0` is the wire encoding for "no expiry"; non-zero values are interpreted
//! as Unix seconds (`i64`).
//!
//! The builder delegates to the Codama-generated
//! [`payment_channels_client::types::VoucherArgs`] struct via borsh, so the
//! produced bytes track whatever the on-chain program accepts at the pinned
//! upstream revision without any hand-rolled layout code in this crate.

use payment_channels_client::types::VoucherArgs;
use solana_address::Address;
use solana_pubkey::Pubkey;

/// Byte length of the signed voucher payload.
pub const VOUCHER_PAYLOAD_SIZE: usize = 48;

/// Build the 48-byte payload the authorized signer signs for `settle` and
/// `settleAndFinalize`.
///
/// `channel_id` identifies the channel PDA, `cumulative_amount` is the running
/// total in base units, and `expires_at` is a Unix-seconds `i64` (or `0` to
/// signal no expiry). The returned array is the exact byte sequence the
/// on-chain program reconstructs and verifies against the signer.
pub fn build_signed_payload(
    channel_id: &Pubkey,
    cumulative_amount: u64,
    expires_at: i64,
) -> [u8; VOUCHER_PAYLOAD_SIZE] {
    let args = VoucherArgs {
        channel_id: Address::new_from_array(channel_id.to_bytes()),
        cumulative_amount,
        expires_at,
    };
    borsh::to_vec(&args)
        .expect("borsh serialization of fixed-size VoucherArgs cannot fail")
        .try_into()
        .expect("VoucherArgs serializes to exactly VOUCHER_PAYLOAD_SIZE bytes (32 + 8 + 8)")
}
