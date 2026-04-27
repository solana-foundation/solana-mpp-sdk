//! Voucher signed-payload builder (Contract 1) and off-chain verification.
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
//!
//! Alongside the byte contract, this module exposes the [`VoucherSigner`]
//! abstraction (so KMS / HSM-backed signers can plug in later without forcing
//! the SDK onto a different signing crate) and [`verify_voucher_signature`],
//! the off-chain pre-flight check that mirrors what the on-chain ed25519
//! precompile would do. The on-chain precompile remains the authoritative
//! verifier; the off-chain helper is a fail-fast pre-check.

use payment_channels_client::types::VoucherArgs;
use solana_address::Address;
use solana_ed25519_program::new_ed25519_instruction_with_signature;
use solana_instruction::Instruction;
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

/// Error returned by a fallible voucher signer (KMS, HSM, remote signer, etc.).
/// In-process signers like [`ed25519_dalek::SigningKey`] never produce this
/// error because their signing operation is infallible.
///
/// The variant is a single opaque message rather than a structured enum
/// because the SDK has no opinion on what KMS-side failures mean to the
/// caller; the expectation is the caller logs / surfaces the message and
/// aborts the settle attempt.
#[derive(Debug, thiserror::Error)]
#[error("voucher signer failed: {0}")]
pub struct SignerError(pub String);

impl SignerError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }
}

/// Anything that can sign a 48-byte voucher payload and surface the matching
/// ed25519 verifying key.
///
/// The SDK ships a blanket impl for [`ed25519_dalek::SigningKey`]. KMS or
/// HSM-backed signers can implement this trait later without forcing the rest
/// of the SDK onto a different signing crate. Implementations must produce a
/// detached ed25519 signature over `payload` that verifies under the key
/// returned by [`Self::verifying_key_bytes`].
///
/// `sign_voucher_payload` is fallible because remote signers (KMS, HSM,
/// custodial wallets) can fail, time out, or rate-limit. In-process signers
/// like [`ed25519_dalek::SigningKey`] always return `Ok`.
pub trait VoucherSigner {
    /// Returns the 32-byte ed25519 verifying key paired with this signer.
    fn verifying_key_bytes(&self) -> [u8; 32];

    /// Produces a detached ed25519 signature over the 48-byte voucher payload.
    fn sign_voucher_payload(
        &self,
        payload: &[u8; VOUCHER_PAYLOAD_SIZE],
    ) -> Result<[u8; 64], SignerError>;
}

impl VoucherSigner for ed25519_dalek::SigningKey {
    fn verifying_key_bytes(&self) -> [u8; 32] {
        self.verifying_key().to_bytes()
    }

    fn sign_voucher_payload(
        &self,
        payload: &[u8; VOUCHER_PAYLOAD_SIZE],
    ) -> Result<[u8; 64], SignerError> {
        use ed25519_dalek::Signer;
        Ok(self.sign(payload).to_bytes())
    }
}

/// Build the ed25519 precompile instruction the on-chain program expects
/// before settle / settle-and-finalize. Composes:
///
///   build_signed_payload(channel_id, cumulative_amount, expires_at)
///   + signer.sign_voucher_payload(payload)
///   + signer.verifying_key_bytes()
///   + Solana's canonical `new_ed25519_instruction_with_signature`
///
/// Returns an [`Instruction`] with the ed25519 precompile program id, no
/// accounts, and the canonical 160-byte single-signature inline-message data.
/// Fails if the signer fails (e.g. a remote KMS rejects the request).
pub fn build_verify_ix<S: VoucherSigner + ?Sized>(
    channel_id: &Pubkey,
    cumulative_amount: u64,
    expires_at: i64,
    signer: &S,
) -> Result<Instruction, SignerError> {
    let payload = build_signed_payload(channel_id, cumulative_amount, expires_at);
    let signature = signer.sign_voucher_payload(&payload)?;
    let pubkey = signer.verifying_key_bytes();
    Ok(new_ed25519_instruction_with_signature(
        &payload,
        &signature,
        &pubkey,
    ))
}

/// Errors returned by [`verify_voucher_signature`].
///
/// The two variants are kept distinct so callers can tell a malformed
/// verifying key (bad pubkey bytes that do not decode at all) apart from a
/// well-formed key whose signature failed to verify against the payload. Both
/// variants are deliberately opaque: the SDK does not surface the underlying
/// `ed25519-dalek` error so callers do not key off internal variants.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VoucherSignatureError {
    /// The provided pubkey bytes do not decode as a valid ed25519 verifying
    /// key (bad point on the curve, etc.).
    #[error("malformed verifying key")]
    MalformedKey,
    /// The signature did not verify against the verifying key + payload.
    /// Mirrors the on-chain precompile, which does not distinguish failure
    /// modes beyond "rejected".
    #[error("voucher signature verification failed")]
    VerificationFailed,
}

/// Off-chain ed25519 verification of a voucher payload.
///
/// Mirrors what the on-chain precompile would check: structural pubkey
/// validity plus signature validity under
/// [`ed25519_dalek::VerifyingKey::verify_strict`], which rejects malleable
/// signatures and small-order pubkey edge cases.
///
/// Use this on the server side to fail fast on bad signatures before paying
/// network fees to submit a settle transaction. The on-chain precompile is
/// still the authoritative verifier; this is a pre-flight check.
pub fn verify_voucher_signature(
    pubkey: &[u8; 32],
    signature: &[u8; 64],
    payload: &[u8; VOUCHER_PAYLOAD_SIZE],
) -> Result<(), VoucherSignatureError> {
    let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(pubkey)
        .map_err(|_| VoucherSignatureError::MalformedKey)?;
    let signature = ed25519_dalek::Signature::from_bytes(signature);
    verifying_key
        .verify_strict(payload, &signature)
        .map_err(|_| VoucherSignatureError::VerificationFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    #[test]
    fn verify_voucher_signature_round_trip() {
        let signing_key = SigningKey::from_bytes(&[1u8; 32]);
        let channel_id = Pubkey::new_from_array([7u8; 32]);
        let payload = build_signed_payload(&channel_id, 1_234_567, 1_700_000_000);

        let signature = signing_key
            .sign_voucher_payload(&payload)
            .expect("in-process dalek signer is infallible");
        let pubkey = signing_key.verifying_key_bytes();

        verify_voucher_signature(&pubkey, &signature, &payload)
            .expect("voucher signature should verify under its own signing key");
    }

    #[test]
    fn verify_voucher_signature_rejects_tampered_signature() {
        let signing_key = SigningKey::from_bytes(&[2u8; 32]);
        let channel_id = Pubkey::new_from_array([9u8; 32]);
        let payload = build_signed_payload(&channel_id, 42, 0);

        let mut signature = signing_key
            .sign_voucher_payload(&payload)
            .expect("in-process dalek signer is infallible");
        let pubkey = signing_key.verifying_key_bytes();

        // Flip a single bit in the signature; verification must fail.
        signature[0] ^= 0x01;

        assert_eq!(
            verify_voucher_signature(&pubkey, &signature, &payload),
            Err(VoucherSignatureError::VerificationFailed),
        );
    }

    #[test]
    fn verify_voucher_signature_rejects_zero_signature() {
        let signing_key = SigningKey::from_bytes(&[3u8; 32]);
        let channel_id = Pubkey::new_from_array([5u8; 32]);
        let payload = build_signed_payload(&channel_id, 99, 0);

        let pubkey = signing_key.verifying_key_bytes();
        let signature = [0u8; 64];

        assert_eq!(
            verify_voucher_signature(&pubkey, &signature, &payload),
            Err(VoucherSignatureError::VerificationFailed),
        );
    }

    #[test]
    fn verify_voucher_signature_rejects_wrong_pubkey() {
        let signing_key_a = SigningKey::from_bytes(&[3u8; 32]);
        let signing_key_b = SigningKey::from_bytes(&[4u8; 32]);
        let channel_id = Pubkey::new_from_array([5u8; 32]);
        let payload = build_signed_payload(&channel_id, 99, 1_800_000_000);

        let signature = signing_key_a
            .sign_voucher_payload(&payload)
            .expect("in-process dalek signer is infallible");
        // signing_key_b is a valid (non-malformed) ed25519 key, so any failure
        // here must be VerificationFailed, not MalformedKey.
        let pubkey_b = signing_key_b.verifying_key_bytes();

        assert_eq!(
            verify_voucher_signature(&pubkey_b, &signature, &payload),
            Err(VoucherSignatureError::VerificationFailed),
        );
    }

    #[test]
    fn verify_voucher_signature_rejects_malformed_pubkey() {
        // Compressed Edwards-y = 2 (sign bit clear). Decompression solves
        // x^2 = (y^2 - 1) / (d * y^2 + 1) over the field; for y = 2 the
        // result is a non-residue, so dalek 2.x's `VerifyingKey::from_bytes`
        // rejects it as a malformed pubkey. This exercises the `MalformedKey`
        // path with a structurally-decodable but cryptographically invalid
        // input.
        let mut pubkey = [0u8; 32];
        pubkey[0] = 0x02;
        let signature = [0u8; 64];
        let channel_id = Pubkey::new_from_array([1u8; 32]);
        let payload = build_signed_payload(&channel_id, 0, 0);

        assert_eq!(
            verify_voucher_signature(&pubkey, &signature, &payload),
            Err(VoucherSignatureError::MalformedKey),
        );
    }

    #[test]
    fn build_verify_ix_produces_canonical_layout() {
        use solana_sdk_ids::ed25519_program;

        let signing_key = SigningKey::from_bytes(&[1u8; 32]);
        let channel_id = Pubkey::new_from_array([7u8; 32]);
        let ix = build_verify_ix(&channel_id, 100, 0, &signing_key)
            .expect("in-process dalek signer is infallible");

        // Program id is the ed25519 precompile.
        assert_eq!(ix.program_id.to_bytes(), ed25519_program::ID.to_bytes());
        assert!(ix.accounts.is_empty(), "precompile takes no accounts");
        // Canonical single-signature inline-message layout is 160 bytes total.
        assert_eq!(ix.data.len(), 160);
    }

    #[test]
    fn composer_output_round_trips_through_off_chain_verify() {
        let signing_key = SigningKey::from_bytes(&[1u8; 32]);
        let channel_id = Pubkey::new_from_array([7u8; 32]);
        let ix = build_verify_ix(&channel_id, 100, 0, &signing_key)
            .expect("in-process dalek signer is infallible");

        // Extract bytes from the canonical layout: pubkey at 16..48,
        // signature at 48..112, message at 112..160.
        let pubkey: [u8; 32] = ix.data[16..48].try_into().unwrap();
        let signature: [u8; 64] = ix.data[48..112].try_into().unwrap();
        let message: [u8; VOUCHER_PAYLOAD_SIZE] = ix.data[112..160].try_into().unwrap();

        // Pubkey in the ix matches the signer's.
        assert_eq!(pubkey, signing_key.verifying_key_bytes());
        // Signature verifies off-chain.
        assert!(verify_voucher_signature(&pubkey, &signature, &message).is_ok());
    }
}
