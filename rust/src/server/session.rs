#![allow(dead_code, unused_imports, unused_variables)]
// Draft module pending rewrite as the session-store layer lands.
#![cfg(any())]

//! Server-side session intent — challenge issuance, voucher verification,
//! and channel lifecycle management.
//!
//! # Overview
//!
//! 1. Server calls [`SessionServer::build_challenge_request`] to produce the
//!    `SessionRequest` embedded in a 402 challenge.
//! 2. Client responds with `SessionAction::Open` — server calls
//!    [`SessionServer::process_open`] to record the channel.
//! 3. For each subsequent API call the client attaches `SessionAction::Voucher`
//!    — server calls [`SessionServer::verify_voucher`] to validate and advance
//!    the settled watermark atomically.
//! 4. At session end the client (or server) triggers close. The server calls
//!    [`SessionServer::finalize_params`] to get the parameters needed to
//!    submit on-chain finalize + distribute transactions.
//!
//! # Note on on-chain verification
//!
//! `process_open` and `process_topup` currently trust the provided transaction
//! signature and deposit amount. For production use, wire up an RPC client to
//! verify the transactions on-chain before persisting channel state.

use solana_pubkey::Pubkey;

use crate::error::{Error, Result};
use crate::protocol::core::base64url_decode;
use crate::protocol::intents::session::{
    ClosePayload, OpenPayload, SessionMode, SessionRequest, SessionSplit, SignedVoucher,
    TopUpPayload, VoucherPayload,
};
use crate::store::{ChannelState, ChannelStore, StoreError};

// ── Configuration ──

/// A payment split committed at channel open; distributed at close.
#[derive(Debug, Clone)]
pub struct Split {
    pub recipient: Pubkey,
    /// Fixed amount in base units.
    pub amount: u64,
}

/// Server configuration for the session intent.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Operator public key (base58). Shown to clients in the challenge.
    pub operator: String,

    /// Primary payment recipient (base58).
    pub recipient: String,

    /// Optional splits routed to specific recipients at close.
    pub splits: Vec<Split>,

    /// Maximum cap the server will offer per session (base units).
    /// Clients may request a lower cap but not a higher one.
    pub max_cap: u64,

    /// Currency identifier (e.g., "USDC", mint address).
    pub currency: String,

    /// Token decimals (default 6 for USDC).
    pub decimals: u8,

    /// Solana network: "mainnet-beta", "devnet", "localnet".
    pub network: String,

    /// Channel program ID. `None` defaults to the canonical Fiber program.
    pub program_id: Option<Pubkey>,

    /// Minimum voucher increment (base units). 0 = no minimum.
    pub min_voucher_delta: u64,

    /// Session modes this server accepts.
    ///
    /// Advertised to clients in the 402 challenge. An empty list or
    /// `[Push]` means only the Fiber channel (push) mode is supported.
    pub modes: Vec<SessionMode>,

    /// Solana RPC URL for on-chain open-transaction verification.
    ///
    /// When set, `process_open` calls `getSignatureStatuses` to confirm the
    /// open transaction was accepted by the network before persisting channel
    /// state. Leave `None` in unit tests or when you want to skip verification.
    pub rpc_url: Option<String>,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            operator: String::new(),
            recipient: String::new(),
            splits: vec![],
            max_cap: 10_000_000, // 10 USDC
            currency: "USDC".to_string(),
            decimals: 6,
            network: "mainnet-beta".to_string(),
            program_id: None,
            min_voucher_delta: 0,
            modes: vec![SessionMode::Push],
            rpc_url: None,
        }
    }
}

// ── Parameters returned to the caller for on-chain settlement ──

/// Parameters needed to submit a finalize + distribute transaction pair.
#[derive(Debug, Clone)]
pub struct FinalizeParams {
    /// On-chain channel address.
    pub channel_id: Pubkey,

    /// The settled watermark to commit on-chain.
    pub settled: u64,

    /// Primary recipient.
    pub recipient: Pubkey,

    /// Splits for the distribute instruction.
    pub splits: Vec<Split>,

    /// 16-byte distribution hash (Blake3-truncated). Precomputed from
    /// `recipient + splits` at open time; passed to the finalize instruction.
    pub distribution_hash: [u8; 16],
}

// ── Server ──

/// Server-side session manager.
///
/// Generic over the channel store to support in-memory testing and
/// production persistence backends.
pub struct SessionServer<S: ChannelStore> {
    config: SessionConfig,
    store: S,
}

impl<S: ChannelStore> SessionServer<S> {
    pub fn new(config: SessionConfig, store: S) -> Self {
        Self { config, store }
    }

    /// Build the `SessionRequest` to embed in a 402 challenge.
    ///
    /// `cap` is the maximum this session will allow; clamped to `config.max_cap`.
    pub fn build_challenge_request(&self, cap: u64) -> SessionRequest {
        let effective_cap = cap.min(self.config.max_cap);
        SessionRequest {
            cap: effective_cap.to_string(),
            currency: self.config.currency.clone(),
            decimals: Some(self.config.decimals),
            network: Some(self.config.network.clone()),
            operator: self.config.operator.clone(),
            recipient: self.config.recipient.clone(),
            splits: self
                .config
                .splits
                .iter()
                .map(|s| SessionSplit {
                    recipient: bs58::encode(s.recipient.as_ref()).into_string(),
                    amount: s.amount.to_string(),
                })
                .collect(),
            program_id: self
                .config
                .program_id
                .map(|p| bs58::encode(p.as_ref()).into_string()),
            description: None,
            external_id: None,
            min_voucher_delta: if self.config.min_voucher_delta > 0 {
                Some(self.config.min_voucher_delta.to_string())
            } else {
                None
            },
            // Omit if only Push — clients assume Push when modes is absent.
            modes: if self.config.modes == [SessionMode::Push] {
                vec![]
            } else {
                self.config.modes.clone()
            },
            recent_blockhash: None,
        }
    }

    /// Process an `open` action: persist the channel state.
    ///
    /// Accepts both push (Fiber channel) and pull (SPL delegation) modes.
    /// Returns the stored `ChannelState`.
    ///
    /// When `config.rpc_url` is set, confirms the open transaction is finalized
    /// on-chain before persisting — rejects the open if the tx is unknown or
    /// failed. Leave `rpc_url` as `None` in unit tests.
    pub async fn process_open(&self, payload: &OpenPayload) -> Result<ChannelState> {
        let session_id = payload.session_id()?;
        let deposit = payload.deposit_amount()?;

        if deposit == 0 {
            return Err(Error::Other(
                "Deposit must be greater than zero".to_string(),
            ));
        }

        if deposit > self.config.max_cap {
            return Err(Error::Other(format!(
                "Deposit {deposit} exceeds max cap {}",
                self.config.max_cap
            )));
        }

        // On-chain verification: confirm the open transaction was accepted.
        //
        // Pull mode: the delegation state is already validated by the caller via
        // `run_pull_setup` (which fetches and confirms the MultiDelegate + FixedDelegation
        // PDAs on-chain before `process_open` is invoked). Skip tx-sig verification.
        //
        // Push mode: verify the Fiber channel open tx is confirmed before persisting.
        if payload.mode == SessionMode::Push {
            if let Some(ref rpc_url) = self.config.rpc_url {
                verify_open_signature(&payload.signature, rpc_url).map_err(|e| {
                    tracing::warn!(signature = %payload.signature, %e, "open tx verification failed");
                    e
                })?;
                tracing::debug!(signature = %payload.signature, "open tx confirmed on-chain");
            }
        }

        let state = ChannelState {
            channel_id: session_id.to_string(),
            authorized_signer: payload.authorized_signer.clone(),
            deposit,
            cumulative: 0,
            finalized: false,
            highest_voucher_signature: None,
            close_requested_at: None,
            operator: payload.owner.clone(),
        };

        self.store
            .put_channel(session_id, state.clone())
            .await
            .map_err(store_err)?;

        Ok(state)
    }

    /// Verify a voucher, advance the watermark, and return the new cumulative.
    ///
    /// Rejects vouchers that:
    /// - Belong to an unknown channel
    /// - Have a non-increasing cumulative (unless exact idempotent replay)
    /// - Exceed the deposit cap
    /// - Have an invalid signature
    /// - Are below the minimum voucher delta
    /// - Are submitted after a close has been requested
    ///
    /// Uses atomic read-modify-write to prevent double-spend under concurrent requests.
    pub async fn verify_voucher(&self, payload: &VoucherPayload) -> Result<u64> {
        let voucher = &payload.voucher;
        let channel_id = &voucher.data.channel_id;

        // 1. Parse new_cumulative from payload
        let new_cumulative: u64 = voucher
            .data
            .cumulative
            .parse()
            .map_err(|_| Error::Other("Invalid cumulative in voucher".to_string()))?;

        // 2. Get channel state (for authorized_signer — never changes after open)
        let state = self
            .store
            .get_channel(channel_id)
            .await
            .map_err(store_err)?
            .ok_or_else(|| Error::Other(format!("Channel {channel_id} not found")))?;

        // 3. Check finalized
        if state.finalized {
            return Err(Error::Other("Channel is already finalized".to_string()));
        }

        // 4. Check close-pending
        if state.close_requested_at.is_some() {
            return Err(Error::Other(
                "Channel close is pending — no further vouchers accepted".to_string(),
            ));
        }

        // 5. Idempotent replay: same cumulative AND same signature
        if new_cumulative == state.cumulative
            && state.highest_voucher_signature.as_deref() == Some(voucher.signature.as_str())
        {
            verify_signature(voucher, &state.authorized_signer)?;
            return Ok(new_cumulative);
        }

        // 6. Must exceed watermark (non-replay case)
        if new_cumulative <= state.cumulative {
            return Err(Error::Other(format!(
                "Voucher cumulative {new_cumulative} must exceed watermark {}",
                state.cumulative
            )));
        }

        // 7. Must not exceed deposit
        if new_cumulative > state.deposit {
            return Err(Error::Other(format!(
                "Voucher cumulative {new_cumulative} exceeds deposit {}",
                state.deposit
            )));
        }

        // 8. Min delta check
        let delta = new_cumulative - state.cumulative;
        let min = self.config.min_voucher_delta;
        if min > 0 && delta < min {
            return Err(Error::Other(format!(
                "Voucher delta {delta} is below minimum {min}"
            )));
        }

        // 9. Verify signature (expensive, before touching store)
        verify_signature(voucher, &state.authorized_signer)?;

        // 10. Clone sig for use in closure
        let sig = voucher.signature.clone();

        // 11. Atomic read-modify-write
        let new_state = self
            .store
            .update_channel(
                channel_id,
                Box::new(move |state_opt| {
                    let state = state_opt
                        .ok_or_else(|| StoreError::Internal("Channel not found".to_string()))?;
                    // Re-check finalized inside closure
                    if state.finalized {
                        return Err(StoreError::Internal(
                            "Channel is already finalized".to_string(),
                        ));
                    }
                    // Re-check close-pending inside closure
                    if state.close_requested_at.is_some() {
                        return Err(StoreError::Internal(
                            "Channel close is pending — no further vouchers accepted".to_string(),
                        ));
                    }
                    // Idempotent replay inside closure
                    if new_cumulative == state.cumulative
                        && state.highest_voucher_signature.as_deref() == Some(&sig)
                    {
                        return Ok(state);
                    }
                    // Concurrent watermark advancement check
                    if new_cumulative <= state.cumulative {
                        return Err(StoreError::Internal(
                            "Concurrent update: watermark advanced".to_string(),
                        ));
                    }
                    Ok(ChannelState {
                        cumulative: new_cumulative,
                        highest_voucher_signature: Some(sig),
                        ..state
                    })
                }),
            )
            .await
            .map_err(store_err)?;

        // 12. Return new cumulative
        Ok(new_state.cumulative)
    }

    /// Process a `topup` action: atomically update the channel's deposit cap.
    ///
    /// The new deposit must be greater than the current deposit.
    /// In production, verify the top-up transaction on-chain first.
    pub async fn process_topup(&self, payload: &TopUpPayload) -> Result<ChannelState> {
        let new_deposit: u64 = payload
            .new_deposit
            .parse()
            .map_err(|_| Error::Other("Invalid new_deposit".to_string()))?;
        let max_cap = self.config.max_cap;
        let cid = payload.channel_id.clone();
        self.store
            .update_channel(
                &payload.channel_id,
                Box::new(move |state_opt| {
                    let state = state_opt
                        .ok_or_else(|| StoreError::Internal(format!("Channel {cid} not found")))?;
                    if new_deposit <= state.deposit {
                        return Err(StoreError::Internal(format!(
                            "New deposit {new_deposit} must exceed current deposit {}",
                            state.deposit
                        )));
                    }
                    if new_deposit > max_cap {
                        return Err(StoreError::Internal(format!(
                            "New deposit {new_deposit} exceeds max cap {max_cap}"
                        )));
                    }
                    Ok(ChannelState {
                        deposit: new_deposit,
                        ..state
                    })
                }),
            )
            .await
            .map_err(store_err)
    }

    /// Process a `close` action: atomically set close-pending, accept a final
    /// voucher if provided, and return the parameters needed for on-chain settlement.
    pub async fn process_close(&self, payload: &ClosePayload) -> Result<FinalizeParams> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let voucher_opt = payload.voucher.clone();

        self.store
            .update_channel(
                &payload.channel_id,
                Box::new(move |state_opt| {
                    let state = state_opt.ok_or_else(|| {
                        StoreError::Internal("Channel not found".to_string())
                    })?;
                    if state.finalized {
                        return Err(StoreError::Internal(
                            "Channel is already finalized".to_string(),
                        ));
                    }
                    if state.close_requested_at.is_some() {
                        return Err(StoreError::Internal("Close already requested".to_string()));
                    }

                    let (new_cumulative, new_sig) = if let Some(ref voucher) = voucher_opt {
                        let cumulative: u64 = voucher
                            .data
                            .cumulative
                            .parse()
                            .map_err(|_| StoreError::Internal("Invalid cumulative".to_string()))?;
                        if cumulative <= state.cumulative {
                            // Idempotent replay check
                            if cumulative == state.cumulative
                                && state.highest_voucher_signature.as_deref()
                                    == Some(voucher.signature.as_str())
                            {
                                (state.cumulative, state.highest_voucher_signature.clone())
                            } else {
                                return Err(StoreError::Internal(format!(
                                    "Final voucher cumulative {cumulative} must exceed watermark {}",
                                    state.cumulative
                                )));
                            }
                        } else {
                            if cumulative > state.deposit {
                                return Err(StoreError::Internal(
                                    "Final voucher exceeds deposit".to_string(),
                                ));
                            }
                            verify_signature(voucher, &state.authorized_signer)
                                .map_err(|e| StoreError::Internal(e.to_string()))?;
                            (cumulative, Some(voucher.signature.clone()))
                        }
                    } else {
                        (state.cumulative, state.highest_voucher_signature.clone())
                    };

                    Ok(ChannelState {
                        cumulative: new_cumulative,
                        highest_voucher_signature: new_sig,
                        close_requested_at: Some(now),
                        ..state
                    })
                }),
            )
            .await
            .map_err(store_err)?;

        self.finalize_params(&payload.channel_id).await
    }

    /// Return finalize parameters for a channel ready for on-chain settlement.
    pub async fn finalize_params(&self, channel_id: &str) -> Result<FinalizeParams> {
        let state = self
            .store
            .get_channel(channel_id)
            .await
            .map_err(store_err)?
            .ok_or_else(|| Error::Other(format!("Channel {channel_id} not found")))?;

        let channel_pubkey = parse_pubkey(channel_id)?;
        let recipient_pubkey = parse_pubkey(&self.config.recipient)?;

        let splits_with_pubkeys: Vec<(Pubkey, u64)> = self
            .config
            .splits
            .iter()
            .map(|s| Ok((s.recipient, s.amount)))
            .collect::<Result<Vec<_>>>()?;

        let distribution_hash = compute_distribution_hash(&recipient_pubkey, &splits_with_pubkeys);

        Ok(FinalizeParams {
            channel_id: channel_pubkey,
            settled: state.cumulative,
            recipient: recipient_pubkey,
            splits: self.config.splits.clone(),
            distribution_hash,
        })
    }

    /// Mark a channel as finalized (call after the on-chain finalize tx confirms).
    pub async fn mark_finalized(&self, channel_id: &str) -> Result<()> {
        self.store
            .mark_finalized(channel_id)
            .await
            .map_err(store_err)
    }
}

// ── Helpers ──

fn store_err(e: StoreError) -> Error {
    Error::Other(e.to_string())
}

/// Confirm that `sig_str` is a finalized, successful transaction on-chain.
///
/// Uses the blocking `RpcClient` — consistent with the rest of this module.
/// Returns an error if the signature is malformed, the tx was rejected, or
/// the tx is not found (not yet processed or doesn't exist).
#[cfg(feature = "server")]
fn verify_open_signature(sig_str: &str, rpc_url: &str) -> Result<()> {
    use solana_rpc_client::rpc_client::RpcClient;
    use solana_signature::Signature;
    use std::str::FromStr;

    let sig = Signature::from_str(sig_str)
        .map_err(|e| Error::Other(format!("invalid open tx signature '{sig_str}': {e}")))?;

    let rpc = RpcClient::new(rpc_url.to_string());

    match rpc
        .get_signature_status(&sig)
        .map_err(|e| Error::Other(format!("RPC error verifying open tx: {e}")))?
    {
        Some(Ok(())) => Ok(()),
        Some(Err(e)) => Err(Error::Other(format!("open tx was rejected on-chain: {e}"))),
        None => Err(Error::Other(format!(
            "open tx '{sig_str}' not found — not yet confirmed or does not exist"
        ))),
    }
}

fn parse_pubkey(s: &str) -> Result<Pubkey> {
    let bytes = bs58::decode(s)
        .into_vec()
        .map_err(|e| Error::Other(format!("Invalid pubkey {s}: {e}")))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| Error::Other(format!("Pubkey {s} is not 32 bytes")))?;
    Ok(Pubkey::from(arr))
}

/// Verify an Ed25519 voucher signature against the authorized signer.
fn verify_signature(voucher: &SignedVoucher, authorized_signer: &str) -> Result<()> {
    use ed25519_dalek::{Signature, VerifyingKey};

    let canonical = voucher.data.canonical_bytes()?;

    let sig_bytes = base64url_decode(&voucher.signature)
        .map_err(|e| Error::Other(format!("Invalid signature encoding: {e}")))?;
    let pubkey_bytes = bs58::decode(authorized_signer)
        .into_vec()
        .map_err(|e| Error::Other(format!("Invalid authorized_signer: {e}")))?;

    let key_arr: [u8; 32] = pubkey_bytes
        .try_into()
        .map_err(|_| Error::Other("Pubkey is not 32 bytes".to_string()))?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| Error::Other("Signature is not 64 bytes".to_string()))?;

    let verifying_key = VerifyingKey::from_bytes(&key_arr)
        .map_err(|e| Error::Other(format!("Invalid authorized_signer key: {e}")))?;
    let signature = Signature::from_bytes(&sig_arr);

    verifying_key
        .verify_strict(&canonical, &signature)
        .map_err(|_| Error::Other("Voucher signature verification failed".to_string()))
}

/// Compute the 16-byte distribution hash committed at channel open time.
///
/// Matches the Fiber SDK's `distribution_hash(recipient, splits)`:
/// Blake3 over `(recipient_bytes || split_recipient_bytes || split_amount_le)*`,
/// truncated to 128 bits.
pub fn compute_distribution_hash(recipient: &Pubkey, splits: &[(Pubkey, u64)]) -> [u8; 16] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(recipient.as_ref());
    for (split_recipient, amount) in splits {
        hasher.update(split_recipient.as_ref());
        hasher.update(&amount.to_le_bytes());
    }
    let result = hasher.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&result.as_bytes()[..16]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::intents::session::{
        ClosePayload, OpenPayload, SessionMode, VoucherData, VoucherPayload,
    };
    use crate::store::MemoryChannelStore;

    const RECIPIENT: &str = "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY";

    fn make_server() -> SessionServer<MemoryChannelStore> {
        SessionServer::new(
            SessionConfig {
                operator: RECIPIENT.to_string(),
                recipient: RECIPIENT.to_string(),
                splits: vec![],
                max_cap: 10_000_000,
                currency: "USDC".to_string(),
                decimals: 6,
                network: "localnet".to_string(),
                program_id: None,
                min_voucher_delta: 0,
                modes: vec![SessionMode::Push],
                rpc_url: None,
            },
            MemoryChannelStore::new(),
        )
    }

    fn make_server_with_min_delta(min_delta: u64) -> SessionServer<MemoryChannelStore> {
        SessionServer::new(
            SessionConfig {
                operator: RECIPIENT.to_string(),
                recipient: RECIPIENT.to_string(),
                splits: vec![],
                max_cap: 10_000_000,
                currency: "USDC".to_string(),
                decimals: 6,
                network: "localnet".to_string(),
                program_id: None,
                min_voucher_delta: min_delta,
                modes: vec![SessionMode::Push],
                rpc_url: None,
            },
            MemoryChannelStore::new(),
        )
    }

    fn open_payload(channel_id: &str, deposit: u64, signer: &str) -> OpenPayload {
        OpenPayload::push(
            channel_id.to_string(),
            deposit.to_string(),
            signer.to_string(),
            "dummy_tx_sig".to_string(),
        )
    }

    // ── E2E helpers ──────────────────────────────────────────────────────────

    /// Build a deterministic MemorySigner + ActiveSession from a fixed seed.
    /// Returns (session, authorized_signer_b58, channel_id_b58).
    #[cfg(feature = "client")]
    fn make_e2e_session() -> (
        crate::client::session::ActiveSession,
        String, // authorized_signer
        String, // channel_id (base58)
        Pubkey, // channel Pubkey
    ) {
        use solana_keychain::MemorySigner;
        let sk = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
        let vk = sk.verifying_key();
        let mut kp = [0u8; 64];
        kp[..32].copy_from_slice(sk.as_bytes());
        kp[32..].copy_from_slice(vk.as_bytes());
        let signer: Box<dyn solana_keychain::SolanaSigner> =
            Box::new(MemorySigner::from_bytes(&kp).expect("valid keypair"));
        let auth_signer = bs58::encode(vk.as_bytes()).into_string();
        let channel = Pubkey::new_unique();
        let chan_str = bs58::encode(channel.as_ref()).into_string();
        let session = crate::client::session::ActiveSession::new(channel, signer);
        (session, auth_signer, chan_str, channel)
    }

    // ── process_open ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn process_open_stores_state() {
        let server = make_server();
        let state = server
            .process_open(&open_payload("chan1", 1_000_000, "signer1"))
            .await
            .unwrap();
        assert_eq!(state.deposit, 1_000_000);
        assert_eq!(state.cumulative, 0);
        assert!(!state.finalized);
        assert_eq!(state.authorized_signer, "signer1");
    }

    #[tokio::test]
    async fn process_open_zero_deposit_rejected() {
        let server = make_server();
        assert!(server
            .process_open(&open_payload("chan1", 0, "signer1"))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn process_open_exceeds_cap_rejected() {
        let server = make_server();
        assert!(server
            .process_open(&open_payload("chan1", 20_000_000, "signer1"))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn process_open_exactly_at_cap_accepted() {
        let server = make_server();
        let state = server
            .process_open(&open_payload("chan1", 10_000_000, "s"))
            .await
            .unwrap();
        assert_eq!(state.deposit, 10_000_000);
    }

    // ── build_challenge_request ───────────────────────────────────────────────

    #[test]
    fn build_challenge_request_clamps_cap() {
        let server = make_server();
        let req = server.build_challenge_request(50_000_000);
        assert_eq!(req.cap, "10000000");
    }

    #[test]
    fn build_challenge_request_below_cap() {
        let server = make_server();
        let req = server.build_challenge_request(5_000_000);
        assert_eq!(req.cap, "5000000");
    }

    #[test]
    fn build_challenge_request_includes_fields() {
        let server = make_server();
        let req = server.build_challenge_request(1_000_000);
        assert_eq!(req.operator, RECIPIENT);
        assert_eq!(req.recipient, RECIPIENT);
        assert_eq!(req.currency, "USDC");
        assert_eq!(req.decimals, Some(6));
        assert_eq!(req.network.as_deref(), Some("localnet"));
        assert!(req.splits.is_empty());
    }

    #[test]
    fn build_challenge_request_with_splits() {
        let split_pk = Pubkey::new_unique();
        let config = SessionConfig {
            operator: RECIPIENT.to_string(),
            recipient: RECIPIENT.to_string(),
            splits: vec![Split {
                recipient: split_pk,
                amount: 100_000,
            }],
            max_cap: 10_000_000,
            currency: "USDC".to_string(),
            decimals: 6,
            network: "mainnet-beta".to_string(),
            program_id: None,
            min_voucher_delta: 0,
            modes: vec![SessionMode::Push],
            rpc_url: None,
        };
        let server = SessionServer::new(config, MemoryChannelStore::new());
        let req = server.build_challenge_request(5_000_000);
        assert_eq!(req.splits.len(), 1);
        assert_eq!(req.splits[0].amount, "100000");
    }

    #[test]
    fn build_challenge_request_min_voucher_delta() {
        let config = SessionConfig {
            operator: RECIPIENT.to_string(),
            recipient: RECIPIENT.to_string(),
            splits: vec![],
            max_cap: 10_000_000,
            currency: "USDC".to_string(),
            decimals: 6,
            network: "localnet".to_string(),
            program_id: None,
            min_voucher_delta: 500,
            modes: vec![SessionMode::Push],
            rpc_url: None,
        };
        let server = SessionServer::new(config, MemoryChannelStore::new());
        let req = server.build_challenge_request(5_000_000);
        assert_eq!(req.min_voucher_delta.as_deref(), Some("500"));
    }

    #[test]
    fn build_challenge_request_omits_modes_when_push_only() {
        let server = make_server(); // modes: [Push]
        let req = server.build_challenge_request(1_000_000);
        assert!(req.modes.is_empty(), "Push-only should omit modes field");
    }

    #[test]
    fn build_challenge_request_includes_modes_when_pull_supported() {
        let config = SessionConfig {
            operator: RECIPIENT.to_string(),
            recipient: RECIPIENT.to_string(),
            splits: vec![],
            max_cap: 10_000_000,
            currency: "USDC".to_string(),
            decimals: 6,
            network: "localnet".to_string(),
            program_id: None,
            min_voucher_delta: 0,
            modes: vec![SessionMode::Push, SessionMode::Pull],
            rpc_url: None,
        };
        let server = SessionServer::new(config, MemoryChannelStore::new());
        let req = server.build_challenge_request(1_000_000);
        assert_eq!(req.modes.len(), 2);
        assert!(req.modes.contains(&SessionMode::Push));
        assert!(req.modes.contains(&SessionMode::Pull));
    }

    // ── verify_voucher ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn verify_voucher_unknown_channel() {
        let server = make_server();
        let voucher = SignedVoucher {
            data: VoucherData {
                channel_id: "unknown".to_string(),
                cumulative: "100".to_string(),
                nonce: Some(1),
            },
            signature: "AAAA".to_string(),
        };
        let err = server.verify_voucher(&VoucherPayload { voucher }).await;
        assert!(err.is_err());
        assert!(err.unwrap_err().to_string().contains("not found"));
    }

    #[cfg(feature = "client")]
    #[tokio::test]
    async fn verify_voucher_valid_end_to_end() {
        let server = make_server();
        let (mut session, auth_signer, chan_str, _) = make_e2e_session();
        server
            .process_open(&open_payload(&chan_str, 5_000_000, &auth_signer))
            .await
            .unwrap();

        let voucher = session.sign_increment(1_000_000).await.unwrap();
        let result = server.verify_voucher(&VoucherPayload { voucher }).await;
        assert_eq!(result.unwrap(), 1_000_000);
    }

    #[cfg(feature = "client")]
    #[tokio::test]
    async fn verify_voucher_advances_watermark() {
        let server = make_server();
        let (mut session, auth_signer, chan_str, _) = make_e2e_session();
        server
            .process_open(&open_payload(&chan_str, 5_000_000, &auth_signer))
            .await
            .unwrap();

        // First voucher succeeds
        let v1 = session.sign_increment(500_000).await.unwrap();
        server
            .verify_voucher(&VoucherPayload {
                voucher: v1.clone(),
            })
            .await
            .unwrap();

        // Idempotent replay of exact same voucher (same cumulative + same signature) succeeds
        let v1_replay = v1.clone();
        let replay_result = server
            .verify_voucher(&VoucherPayload { voucher: v1_replay })
            .await;
        assert_eq!(
            replay_result.unwrap(),
            500_000,
            "Idempotent replay should return same cumulative"
        );

        // Next voucher with higher cumulative succeeds
        let v2 = session.sign_increment(500_000).await.unwrap();
        let result = server.verify_voucher(&VoucherPayload { voucher: v2 }).await;
        assert_eq!(result.unwrap(), 1_000_000);
    }

    #[tokio::test]
    async fn verify_voucher_stale_cumulative_rejected() {
        let server = make_server();
        server
            .process_open(&open_payload("chan1", 5_000_000, "signer1"))
            .await
            .unwrap();

        // Manually advance watermark via store
        server
            .store
            .advance_cumulative("chan1", 0, 500_000)
            .await
            .unwrap();

        let voucher = SignedVoucher {
            data: VoucherData {
                channel_id: "chan1".to_string(),
                cumulative: "100".to_string(), // below watermark
                nonce: None,
            },
            signature: "AAAA".to_string(),
        };
        let err = server.verify_voucher(&VoucherPayload { voucher }).await;
        assert!(err.is_err());
        assert!(err.unwrap_err().to_string().contains("watermark"));
    }

    #[tokio::test]
    async fn verify_voucher_exceeds_deposit_rejected() {
        let server = make_server();
        server
            .process_open(&open_payload("chan1", 1_000_000, "signer1"))
            .await
            .unwrap();

        let voucher = SignedVoucher {
            data: VoucherData {
                channel_id: "chan1".to_string(),
                cumulative: "2000000".to_string(), // > deposit
                nonce: None,
            },
            signature: "AAAA".to_string(),
        };
        let err = server.verify_voucher(&VoucherPayload { voucher }).await;
        assert!(err.is_err());
        assert!(err.unwrap_err().to_string().contains("deposit"));
    }

    #[tokio::test]
    async fn verify_voucher_bad_cumulative_format_rejected() {
        let server = make_server();
        server
            .process_open(&open_payload("chan1", 1_000_000, "signer1"))
            .await
            .unwrap();

        let voucher = SignedVoucher {
            data: VoucherData {
                channel_id: "chan1".to_string(),
                cumulative: "not_a_number".to_string(),
                nonce: None,
            },
            signature: "AAAA".to_string(),
        };
        assert!(server
            .verify_voucher(&VoucherPayload { voucher })
            .await
            .is_err());
    }

    #[cfg(feature = "client")]
    #[tokio::test]
    async fn verify_voucher_bad_signature_rejected() {
        let server = make_server();
        let (mut session, auth_signer, chan_str, _) = make_e2e_session();
        server
            .process_open(&open_payload(&chan_str, 5_000_000, &auth_signer))
            .await
            .unwrap();

        let mut voucher = session.sign_increment(1_000_000).await.unwrap();
        // Tamper with the signature
        voucher.signature = crate::protocol::core::base64url_encode(&[0u8; 64]);

        assert!(server
            .verify_voucher(&VoucherPayload { voucher })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn verify_voucher_on_finalized_channel_rejected() {
        let server = make_server();
        server
            .process_open(&open_payload("chan1", 1_000_000, "signer1"))
            .await
            .unwrap();
        server.mark_finalized("chan1").await.unwrap();

        let voucher = SignedVoucher {
            data: VoucherData {
                channel_id: "chan1".to_string(),
                cumulative: "500000".to_string(),
                nonce: None,
            },
            signature: "AAAA".to_string(),
        };
        let err = server.verify_voucher(&VoucherPayload { voucher }).await;
        assert!(err.is_err());
        assert!(err.unwrap_err().to_string().contains("finalized"));
    }

    // ── process_topup ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn process_topup_valid() {
        let server = make_server();
        let chan = "chan1";
        server
            .process_open(&open_payload(chan, 1_000_000, "s"))
            .await
            .unwrap();

        let state = server
            .process_topup(&TopUpPayload {
                channel_id: chan.to_string(),
                new_deposit: "5000000".to_string(),
                signature: "topup_sig".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(state.deposit, 5_000_000);
    }

    #[tokio::test]
    async fn process_topup_lower_deposit_rejected() {
        let server = make_server();
        let chan = "chan1";
        server
            .process_open(&open_payload(chan, 3_000_000, "s"))
            .await
            .unwrap();

        assert!(server
            .process_topup(&TopUpPayload {
                channel_id: chan.to_string(),
                new_deposit: "2000000".to_string(),
                signature: "sig".to_string(),
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn process_topup_exceeds_cap_rejected() {
        let server = make_server();
        let chan = "chan1";
        server
            .process_open(&open_payload(chan, 1_000_000, "s"))
            .await
            .unwrap();

        assert!(server
            .process_topup(&TopUpPayload {
                channel_id: chan.to_string(),
                new_deposit: "20000000".to_string(), // > max_cap
                signature: "sig".to_string(),
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn process_topup_bad_amount_format_rejected() {
        let server = make_server();
        let chan = "chan1";
        server
            .process_open(&open_payload(chan, 1_000_000, "s"))
            .await
            .unwrap();

        assert!(server
            .process_topup(&TopUpPayload {
                channel_id: chan.to_string(),
                new_deposit: "not_a_number".to_string(),
                signature: "sig".to_string(),
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn process_topup_unknown_channel_rejected() {
        let server = make_server();
        assert!(server
            .process_topup(&TopUpPayload {
                channel_id: "ghost".to_string(),
                new_deposit: "5000000".to_string(),
                signature: "sig".to_string(),
            })
            .await
            .is_err());
    }

    // ── process_close ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn process_close_no_voucher() {
        let server = make_server();
        let chan = bs58::encode(Pubkey::new_unique().as_ref()).into_string();
        server
            .process_open(&open_payload(&chan, 5_000_000, "s"))
            .await
            .unwrap();

        let params = server
            .process_close(&ClosePayload {
                channel_id: chan.clone(),
                voucher: None,
            })
            .await
            .unwrap();
        assert_eq!(params.settled, 0);
    }

    #[cfg(feature = "client")]
    #[tokio::test]
    async fn process_close_with_voucher() {
        let server = make_server();
        let (mut session, auth_signer, chan_str, _) = make_e2e_session();
        server
            .process_open(&open_payload(&chan_str, 5_000_000, &auth_signer))
            .await
            .unwrap();

        // Consume 500k first
        let v1 = session.sign_increment(500_000).await.unwrap();
        server
            .verify_voucher(&VoucherPayload { voucher: v1 })
            .await
            .unwrap();

        // Close with a final 200k voucher
        let final_voucher = session.sign_increment(200_000).await.unwrap();
        let params = server
            .process_close(&ClosePayload {
                channel_id: chan_str,
                voucher: Some(final_voucher),
            })
            .await
            .unwrap();
        assert_eq!(params.settled, 700_000);
    }

    #[tokio::test]
    async fn process_close_unknown_channel_rejected() {
        let server = make_server();
        let err = server
            .process_close(&ClosePayload {
                channel_id: bs58::encode(Pubkey::new_unique().as_ref()).into_string(),
                voucher: None,
            })
            .await;
        assert!(err.is_err());
    }

    // ── finalize_params ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn finalize_params_correct() {
        let server = make_server();
        let channel = Pubkey::new_unique();
        let chan_str = bs58::encode(channel.as_ref()).into_string();
        server
            .process_open(&open_payload(&chan_str, 5_000_000, "s"))
            .await
            .unwrap();

        let params = server.finalize_params(&chan_str).await.unwrap();
        assert_eq!(params.channel_id, channel);
        assert_eq!(params.settled, 0);
        assert!(params.splits.is_empty());
        // Hash with no splits should be deterministic
        let recipient = parse_pubkey(RECIPIENT).unwrap();
        let expected_hash = compute_distribution_hash(&recipient, &[]);
        assert_eq!(params.distribution_hash, expected_hash);
    }

    #[tokio::test]
    async fn finalize_params_unknown_channel_rejected() {
        let server = make_server();
        let err = server
            .finalize_params(&bs58::encode(Pubkey::new_unique().as_ref()).into_string())
            .await;
        assert!(err.is_err());
    }

    // ── mark_finalized ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn mark_finalized_sets_flag() {
        let server = make_server();
        server
            .process_open(&open_payload("chan1", 1_000_000, "s"))
            .await
            .unwrap();
        server.mark_finalized("chan1").await.unwrap();

        let state = server.store.get_channel("chan1").await.unwrap().unwrap();
        assert!(state.finalized);
    }

    #[tokio::test]
    async fn mark_finalized_unknown_channel_errors() {
        let server = make_server();
        assert!(server.mark_finalized("ghost").await.is_err());
    }

    // ── distribution_hash ─────────────────────────────────────────────────────

    #[test]
    fn distribution_hash_deterministic() {
        let r = Pubkey::new_unique();
        let s1 = Pubkey::new_unique();
        let h1 = compute_distribution_hash(&r, &[(s1, 500_000)]);
        let h2 = compute_distribution_hash(&r, &[(s1, 500_000)]);
        assert_eq!(h1, h2);
    }

    #[test]
    fn distribution_hash_empty_splits() {
        let r = Pubkey::new_unique();
        let h = compute_distribution_hash(&r, &[]);
        assert_eq!(h.len(), 16);
    }

    #[test]
    fn distribution_hash_changes_with_amount() {
        let r = Pubkey::new_unique();
        let s = Pubkey::new_unique();
        assert_ne!(
            compute_distribution_hash(&r, &[(s, 100)]),
            compute_distribution_hash(&r, &[(s, 200)]),
        );
    }

    #[test]
    fn distribution_hash_changes_with_recipient() {
        let r1 = Pubkey::new_unique();
        let r2 = Pubkey::new_unique();
        assert_ne!(
            compute_distribution_hash(&r1, &[]),
            compute_distribution_hash(&r2, &[]),
        );
    }

    #[test]
    fn distribution_hash_changes_with_split_recipient() {
        let r = Pubkey::new_unique();
        let s1 = Pubkey::new_unique();
        let s2 = Pubkey::new_unique();
        assert_ne!(
            compute_distribution_hash(&r, &[(s1, 100)]),
            compute_distribution_hash(&r, &[(s2, 100)]),
        );
    }

    // ── parse_pubkey helper ───────────────────────────────────────────────────

    #[test]
    fn parse_pubkey_valid() {
        let pk = Pubkey::new_unique();
        let s = bs58::encode(pk.as_ref()).into_string();
        assert_eq!(parse_pubkey(&s).unwrap(), pk);
    }

    #[test]
    fn parse_pubkey_invalid_base58() {
        assert!(parse_pubkey("not!!valid").is_err());
    }

    #[test]
    fn parse_pubkey_wrong_length() {
        // Valid base58 but only 10 bytes
        let s = bs58::encode(&[1u8; 10]).into_string();
        assert!(parse_pubkey(&s).is_err());
    }

    // ── verify_voucher: idempotent replay ────────────────────────────────────

    #[tokio::test]
    async fn verify_voucher_idempotent_replay() {
        let server = make_server();
        // Manually set up a channel with a known highest_voucher_signature
        use crate::store::ChannelState;
        server
            .store
            .put_channel(
                "chan1",
                ChannelState {
                    channel_id: "chan1".to_string(),
                    authorized_signer: "signer1".to_string(),
                    deposit: 5_000_000,
                    cumulative: 1_000_000,
                    finalized: false,
                    highest_voucher_signature: Some("replay_sig".to_string()),
                    close_requested_at: None,
                    operator: None,
                },
            )
            .await
            .unwrap();

        // A voucher with same cumulative AND same signature is idempotent replay
        // (signature verify will fail since it's fake, but let's test the path up to sig verify)
        // We just need to confirm it does NOT fail with "must exceed watermark"
        let voucher = SignedVoucher {
            data: VoucherData {
                channel_id: "chan1".to_string(),
                cumulative: "1000000".to_string(),
                nonce: None,
            },
            signature: "replay_sig".to_string(),
        };
        let err = server
            .verify_voucher(&VoucherPayload { voucher })
            .await
            .unwrap_err();
        // Should fail at signature verification, not watermark check
        let msg = err.to_string();
        assert!(!msg.contains("watermark"), "Expected sig error, got: {msg}");
        // The error is from crypto validation (bad encoding, wrong length, bad key, etc.)
        // Any error other than "watermark" means idempotent replay path was taken correctly
        assert!(
            msg.contains("signature")
                || msg.contains("encoding")
                || msg.contains("Invalid")
                || msg.contains("bytes")
                || msg.contains("key"),
            "Expected signature-related error, got: {msg}"
        );
    }

    // ── verify_voucher: min_delta enforcement ────────────────────────────────

    #[tokio::test]
    async fn verify_voucher_min_delta_enforced() {
        let server = make_server_with_min_delta(500_000);
        server
            .process_open(&open_payload("chan1", 5_000_000, "signer1"))
            .await
            .unwrap();

        // delta = 100_000, min = 500_000 → should be rejected
        let voucher = SignedVoucher {
            data: VoucherData {
                channel_id: "chan1".to_string(),
                cumulative: "100000".to_string(),
                nonce: None,
            },
            signature: "AAAA".to_string(),
        };
        let err = server
            .verify_voucher(&VoucherPayload { voucher })
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("below minimum"),
            "Expected min delta error, got: {err}"
        );
    }

    // ── verify_voucher: close-pending rejection ──────────────────────────────

    #[tokio::test]
    async fn verify_voucher_close_pending_rejected() {
        let server = make_server();
        let chan = bs58::encode(Pubkey::new_unique().as_ref()).into_string();
        server
            .process_open(&open_payload(&chan, 5_000_000, "s"))
            .await
            .unwrap();

        // Close the channel first
        server
            .process_close(&ClosePayload {
                channel_id: chan.clone(),
                voucher: None,
            })
            .await
            .unwrap();

        // Now try to submit a voucher — should be rejected
        let voucher = SignedVoucher {
            data: VoucherData {
                channel_id: chan.clone(),
                cumulative: "100000".to_string(),
                nonce: None,
            },
            signature: "AAAA".to_string(),
        };
        let err = server
            .verify_voucher(&VoucherPayload { voucher })
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("close is pending"),
            "Expected close-pending error, got: {err}"
        );
    }

    // ── process_close: sets close_requested_at ───────────────────────────────

    #[tokio::test]
    async fn process_close_sets_close_pending() {
        let server = make_server();
        let chan = bs58::encode(Pubkey::new_unique().as_ref()).into_string();
        server
            .process_open(&open_payload(&chan, 5_000_000, "s"))
            .await
            .unwrap();

        server
            .process_close(&ClosePayload {
                channel_id: chan.clone(),
                voucher: None,
            })
            .await
            .unwrap();

        let state = server.store.get_channel(&chan).await.unwrap().unwrap();
        assert!(
            state.close_requested_at.is_some(),
            "Expected close_requested_at to be set"
        );
    }

    // ── process_close: prevents double-close ─────────────────────────────────

    #[tokio::test]
    async fn process_close_prevents_double_close() {
        let server = make_server();
        let chan = bs58::encode(Pubkey::new_unique().as_ref()).into_string();
        server
            .process_open(&open_payload(&chan, 5_000_000, "s"))
            .await
            .unwrap();

        // First close succeeds
        server
            .process_close(&ClosePayload {
                channel_id: chan.clone(),
                voucher: None,
            })
            .await
            .unwrap();

        // Second close should fail
        let err = server
            .process_close(&ClosePayload {
                channel_id: chan.clone(),
                voucher: None,
            })
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("Close already requested")
                || err.to_string().contains("close"),
            "Expected double-close error, got: {err}"
        );
    }
}
