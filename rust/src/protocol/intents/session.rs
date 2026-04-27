//! Session intent wire types, aligned to:
//! - `Moonsong-Labs/solana-payment-channels` — `docs/002-http-protocol.md` (HTTP routes,
//!   credential envelopes).
//! - `Moonsong-Labs/solana-payment-channels` — `docs/001-payment-channel-state-machine.md`
//!   (Voucher shape; Borsh-signed bytes).
//! - `solana-foundation/mpp-specs` — `draft-solana-session-00` (envelope shape).
//!
//! Divergences vs draft-00 are recorded in the SDK protocol notes. Notable: vouchers
//! are signed over Borsh 48 bytes, not JCS JSON.

use serde::{Deserialize, Serialize};

// ── Voucher ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoucherData {
    pub channel_id: String,            // base58 Channel PDA
    pub cumulative_amount: String,     // u64 decimal
    /// RFC3339 wire format. `None` means "no expiry"; the field is omitted
    /// from the JSON rather than rendered as `"1970-01-01T00:00:00Z"`.
    /// `Some(0)` is collapsed to `None` at the client emission boundary
    /// (see `ActiveSession::sign_voucher`) so the on-chain `i64` slot for
    /// an absent expiry consistently reads as zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SigType {
    Ed25519,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedVoucher {
    pub voucher: VoucherData,
    pub signer: String,                // base58 Ed25519 public key
    pub signature: String,             // base58 Ed25519 signature over borsh(Voucher)
    pub signature_type: SigType,
}

// ── Challenge request (MPP `request` auth-param, post-base64url + JCS) ─────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_type: Option<String>,
    pub recipient: String,             // primary payee pubkey (base58)
    pub currency: String,              // mint pubkey (base58)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    pub method_details: MethodDetails,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    pub channel_program: String,       // program_id (base58)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,    // resume
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_program: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_payer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_payer_key: Option<String>,
    /// Base58-encoded Solana `Hash`. Blockhash the client MUST use when building
    /// the open/topup/close tx; server commits to this value for the co-sign and
    /// will NOT refresh it. If the blockhash expires before submit, the client
    /// must fetch a fresh 402 challenge and rebuild the tx. Present whenever
    /// `fee_payer_key` is present (Model 1, server-provided preimage).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recent_blockhash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_voucher_delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_period_seconds: Option<u32>,
    pub distribution_splits: Vec<BpsSplit>,
    pub minimum_deposit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BpsSplit {
    pub recipient: String,
    pub share_bps: u16,
}

// ── Internal typed split (typed twin of BpsSplit) ──────────────────────────
//
// `BpsSplit` above is the wire form (base58 `String` recipients). `Split`
// below is the internal typed form stored in `ChannelRecord` and passed to
// low-level builders. Base58 ↔ `Pubkey` conversion happens exactly once, at
// the wire boundary via `wire_to_typed` / `typed_to_wire`. Downstream
// handlers and recovery never re-parse strings; invalid base58 is rejected
// at `store.insert` before any record is persisted.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Split {
    Bps {
        recipient: solana_pubkey::Pubkey,
        share_bps: u16,
    },
}

/// Decode wire `BpsSplit`s (base58 recipient strings) into the internal
/// `Split::Bps` form. Rejects non-canonical base58, wrong-length decodes,
/// or `share_bps > 10_000` via the supplied error mapper. Callers at the
/// wire boundary (`store.insert`, handler entry points) map to
/// `StoreError::Serialization` or `SessionError::InvalidSplit`.
pub fn wire_to_typed<E>(
    splits: &[BpsSplit],
    mut err: impl FnMut(String) -> E,
) -> Result<Vec<Split>, E> {
    splits
        .iter()
        .map(|s| {
            if s.share_bps > 10_000 {
                return Err(err(format!(
                    "share_bps must be <= 10000, got {}",
                    s.share_bps
                )));
            }
            let bytes = bs58::decode(&s.recipient)
                .into_vec()
                .map_err(|e| err(format!("non-canonical base58 in split recipient: {e}")))?;
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| err("split recipient must decode to 32 bytes".into()))?;
            Ok(Split::Bps {
                recipient: solana_pubkey::Pubkey::new_from_array(arr),
                share_bps: s.share_bps,
            })
        })
        .collect()
}

/// Re-encode internal `Split` values to the wire `BpsSplit` form. Infallible:
/// `Pubkey` is always round-trippable to base58.
pub fn typed_to_wire(splits: &[Split]) -> Vec<BpsSplit> {
    splits
        .iter()
        .map(|s| match s {
            Split::Bps { recipient, share_bps } => BpsSplit {
                recipient: bs58::encode(recipient.as_ref()).into_string(),
                share_bps: *share_bps,
            },
        })
        .collect()
}

// ── Credential actions (Authorization header / POST bodies) ────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SessionAction {
    Open(OpenPayload),
    /// Flattened: wire form is
    /// `{"action":"voucher", "voucher":{...}, "signer":"...", "signature":"...",
    ///   "signatureType":"ed25519"}`, the `SignedVoucher` fields sit beside
    /// the action tag, no nested voucher wrapper.
    Voucher(SignedVoucher),
    TopUp(TopUpPayload),
    Close(ClosePayload),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPayload {
    pub challenge_id: String,
    pub channel_id: String,
    pub payer: String,
    pub payee: String,
    pub mint: String,
    pub authorized_signer: String,
    pub salt: String,                  // u64 decimal
    pub bump: u8,                      // advisory; server re-derives canonical
    pub deposit_amount: String,
    pub distribution_splits: Vec<BpsSplit>,
    pub transaction: String,           // base64 partial-signed open tx
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopUpPayload {
    // NOTE: the topup flow binds the on-chain top_up to the challenge issued in
    // the prior 402, so a topup not preceded by a fresh challenge is rejected.
    // The protocol doc must be updated to include this field before v1 ships.
    pub challenge_id: String,
    pub channel_id: String,
    pub additional_amount: String,
    pub transaction: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosePayload {
    pub challenge_id: String,
    pub channel_id: String,
    /// `Some` when `cumulative > on-chain settled`. `None` when nothing new to commit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voucher: Option<SignedVoucher>,
}
