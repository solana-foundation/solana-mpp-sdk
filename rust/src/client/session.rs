#![allow(dead_code, unused_imports, unused_variables)]
// Draft module pending rewrite alongside the high-level wiring layer.
#![cfg(any())]

//! Client-side session intent implementation.
//!
//! Tracks an open payment channel and signs cumulative vouchers for each
//! API call. Vouchers are Ed25519-signed over JCS-canonical JSON.
//!
//! # Example
//!
//! ```ignore
//! use solana_mpp::client::session::ActiveSession;
//!
//! // Obtain a signer (e.g. MemorySigner, hardware wallet, cloud KMS):
//! let signer: Box<dyn solana_keychain::SolanaSigner> = ...;
//! let channel_id = /* Pubkey of the opened on-chain channel */;
//!
//! let mut session = ActiveSession::new(channel_id, signer);
//!
//! // Before each API call, sign a voucher incremented by the request price:
//! let voucher = session.sign_increment(50_000).await?; // +0.05 USDC
//! // Attach voucher to Authorization header via SessionAction::Voucher
//! ```

use solana_keychain::SolanaSigner;
use solana_pubkey::Pubkey;

use crate::error::{Error, Result};
use crate::protocol::core::base64url_encode;
use crate::protocol::intents::session::{
    ClosePayload, OpenPayload, SessionAction, SignedVoucher, TopUpPayload, VoucherData,
    VoucherPayload,
};
// SessionMode is used indirectly via OpenPayload constructors.

/// Tracks the client-side state of an active payment session.
///
/// Holds a `SolanaSigner` session key and advances the cumulative watermark
/// with each signed voucher. The signer may be a local memory signer, a
/// hardware wallet, or any cloud KMS — all are supported through the trait.
pub struct ActiveSession {
    /// On-chain channel address.
    pub channel_id: Pubkey,

    /// Cumulative amount authorized so far (base units).
    pub cumulative: u64,

    /// Nonce counter, incremented with each signed voucher.
    nonce: u64,

    /// Session signing key.
    signer: Box<dyn SolanaSigner>,
}

impl ActiveSession {
    /// Create a new session tracker.
    ///
    /// `channel_id` is the on-chain channel address obtained after opening.
    /// `signer` is the session key — its public key becomes the `authorizedSigner`
    /// passed to the server in the `open` action.
    pub fn new(channel_id: Pubkey, signer: Box<dyn SolanaSigner>) -> Self {
        Self {
            channel_id,
            cumulative: 0,
            nonce: 0,
            signer,
        }
    }

    /// The authorized signer public key (base58), for the `open` action payload.
    pub fn authorized_signer(&self) -> String {
        bs58::encode(self.signer.pubkey().as_ref()).into_string()
    }

    /// Channel ID as base58.
    pub fn channel_id_str(&self) -> String {
        bs58::encode(self.channel_id.as_ref()).into_string()
    }

    /// Sign a voucher with an absolute cumulative amount.
    ///
    /// `cumulative` MUST be strictly greater than the current watermark.
    pub async fn sign_voucher(&mut self, cumulative: u64) -> Result<SignedVoucher> {
        if cumulative <= self.cumulative {
            return Err(Error::Other(format!(
                "Voucher cumulative {cumulative} must exceed current watermark {}",
                self.cumulative
            )));
        }

        self.nonce += 1;
        let data = VoucherData {
            channel_id: self.channel_id_str(),
            cumulative: cumulative.to_string(),
            nonce: Some(self.nonce),
        };

        let bytes = data.canonical_bytes()?;
        let sig = self
            .signer
            .sign_message(&bytes)
            .await
            .map_err(|e| Error::Other(format!("Signing failed: {e}")))?;
        let sig_b64 = base64url_encode(sig.as_ref());

        self.cumulative = cumulative;

        Ok(SignedVoucher {
            data,
            signature: sig_b64,
        })
    }

    /// Sign a voucher adding `amount` to the current cumulative.
    pub async fn sign_increment(&mut self, amount: u64) -> Result<SignedVoucher> {
        self.sign_voucher(self.cumulative + amount).await
    }

    /// Build a `SessionAction::Voucher` wrapping a freshly-signed increment.
    pub async fn voucher_action(&mut self, amount: u64) -> Result<SessionAction> {
        let voucher = self.sign_increment(amount).await?;
        Ok(SessionAction::Voucher(VoucherPayload { voucher }))
    }

    /// Build a `SessionAction::Close` for cooperative channel close.
    ///
    /// If `final_increment` is `Some(n)` and `n > 0`, signs one last voucher
    /// for the remaining balance before closing.
    pub async fn close_action(&mut self, final_increment: Option<u64>) -> Result<SessionAction> {
        let voucher = match final_increment {
            Some(amount) if amount > 0 => Some(self.sign_increment(amount).await?),
            _ => None,
        };
        Ok(SessionAction::Close(ClosePayload {
            channel_id: self.channel_id_str(),
            voucher,
        }))
    }

    /// Build a `SessionAction::Open` for **push** mode (Fiber channel).
    ///
    /// Call this after the on-chain open transaction has been confirmed.
    /// `channel_id` in the session MUST match the confirmed channel address.
    pub fn open_action(&self, deposit: u64, open_tx_signature: &str) -> SessionAction {
        SessionAction::Open(OpenPayload::push(
            self.channel_id_str(),
            deposit.to_string(),
            self.authorized_signer(),
            open_tx_signature.to_string(),
        ))
    }

    /// Build a `SessionAction::Open` for **pull** mode (SPL token delegation).
    ///
    /// Call this after the operator has broadcast and confirmed the `approve`
    /// transaction on behalf of the client.
    ///
    /// - `token_account` is the SPL token account that was delegated (must match
    ///   `self.channel_id` — callers should create the `ActiveSession` with the
    ///   token account pubkey as the channel ID so vouchers bind to it).
    /// - `owner` is the client's wallet pubkey (base58). The operator uses this
    ///   to derive the MultiDelegate PDA at settlement time.
    pub fn open_pull_action(
        &self,
        approved_amount: u64,
        owner: &str,
        approve_tx_signature: &str,
    ) -> SessionAction {
        SessionAction::Open(OpenPayload::pull(
            self.channel_id_str(), // token_account used as the session identifier
            approved_amount.to_string(),
            owner.to_string(),
            self.authorized_signer(),
            approve_tx_signature.to_string(),
        ))
    }

    /// Build a `SessionAction::TopUp` after a top-up transaction.
    pub fn topup_action(&self, new_deposit: u64, topup_tx_signature: &str) -> SessionAction {
        SessionAction::TopUp(TopUpPayload {
            channel_id: self.channel_id_str(),
            new_deposit: new_deposit.to_string(),
            signature: topup_tx_signature.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_keychain::MemorySigner;

    /// Build a deterministic MemorySigner from a fixed 32-byte seed via
    /// ed25519-dalek (already a dep), then pack into the 64-byte format that
    /// solana-keychain's MemorySigner::from_bytes expects.
    fn make_signer() -> Box<dyn SolanaSigner> {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
        let mut kp = [0u8; 64];
        kp[..32].copy_from_slice(sk.as_bytes());
        kp[32..].copy_from_slice(sk.verifying_key().as_bytes());
        Box::new(MemorySigner::from_bytes(&kp).expect("valid keypair"))
    }

    fn make_session() -> ActiveSession {
        ActiveSession::new(Pubkey::new_unique(), make_signer())
    }

    #[tokio::test]
    async fn sign_increment_increases_cumulative() {
        let mut s = make_session();
        assert_eq!(s.cumulative, 0);

        let v = s.sign_increment(100).await.unwrap();
        assert_eq!(s.cumulative, 100);
        assert_eq!(v.data.cumulative, "100");
        assert_eq!(v.data.nonce, Some(1));
    }

    #[tokio::test]
    async fn sign_voucher_absolute() {
        let mut s = make_session();
        s.sign_increment(50).await.unwrap();

        let v = s.sign_voucher(200).await.unwrap();
        assert_eq!(s.cumulative, 200);
        assert_eq!(v.data.cumulative, "200");
    }

    #[tokio::test]
    async fn sign_voucher_rejects_non_increasing() {
        let mut s = make_session();
        s.sign_increment(100).await.unwrap();

        assert!(s.sign_voucher(100).await.is_err());
        assert!(s.sign_voucher(50).await.is_err());
    }

    #[tokio::test]
    async fn sign_voucher_zero_rejected() {
        let mut s = make_session();
        assert!(s.sign_voucher(0).await.is_err());
    }

    #[tokio::test]
    async fn nonce_increments_per_voucher() {
        let mut s = make_session();
        let v1 = s.sign_increment(10).await.unwrap();
        let v2 = s.sign_increment(10).await.unwrap();
        assert_eq!(v1.data.nonce, Some(1));
        assert_eq!(v2.data.nonce, Some(2));
    }

    #[tokio::test]
    async fn voucher_channel_id_matches_session() {
        let mut s = make_session();
        let expected = s.channel_id_str();
        let v = s.sign_increment(100).await.unwrap();
        assert_eq!(v.data.channel_id, expected);
    }

    #[test]
    fn open_action_fields() {
        use crate::protocol::intents::session::SessionMode;
        let s = make_session();
        let channel_id = s.channel_id_str();
        let authorized_signer = s.authorized_signer();
        let action = s.open_action(1_000_000, "txsig123");
        match action {
            SessionAction::Open(p) => {
                assert_eq!(p.mode, SessionMode::Push);
                assert_eq!(p.deposit.as_deref(), Some("1000000"));
                assert_eq!(p.signature, "txsig123");
                assert_eq!(p.channel_id.as_deref(), Some(channel_id.as_str()));
                assert_eq!(p.authorized_signer, authorized_signer);
            }
            _ => panic!("Expected Open"),
        }
    }

    #[test]
    fn open_pull_action_fields() {
        use crate::protocol::intents::session::SessionMode;
        let s = make_session();
        let channel_id = s.channel_id_str(); // used as token_account in pull mode
        let authorized_signer = s.authorized_signer();
        let action = s.open_pull_action(5_000_000, "wallet123", "approvesig");
        match action {
            SessionAction::Open(p) => {
                assert_eq!(p.mode, SessionMode::Pull);
                assert_eq!(p.approved_amount.as_deref(), Some("5000000"));
                assert_eq!(p.signature, "approvesig");
                assert_eq!(p.token_account.as_deref(), Some(channel_id.as_str()));
                assert_eq!(p.owner.as_deref(), Some("wallet123"));
                assert_eq!(p.authorized_signer, authorized_signer);
                assert!(p.channel_id.is_none());
                assert!(p.deposit.is_none());
            }
            _ => panic!("Expected Open"),
        }
    }

    #[test]
    fn topup_action_fields() {
        let s = make_session();
        let action = s.topup_action(5_000_000, "topuptx");
        match action {
            SessionAction::TopUp(p) => {
                assert_eq!(p.new_deposit, "5000000");
                assert_eq!(p.signature, "topuptx");
            }
            _ => panic!("Expected TopUp"),
        }
    }

    #[tokio::test]
    async fn close_action_no_final_increment() {
        let mut s = make_session();
        let action = s.close_action(None).await.unwrap();
        match action {
            SessionAction::Close(p) => {
                assert!(p.voucher.is_none());
            }
            _ => panic!("Expected Close"),
        }
    }

    #[tokio::test]
    async fn close_action_with_final_increment() {
        let mut s = make_session();
        s.sign_increment(100).await.unwrap();
        let action = s.close_action(Some(50)).await.unwrap();
        match action {
            SessionAction::Close(p) => {
                let v = p.voucher.unwrap();
                assert_eq!(v.data.cumulative, "150");
            }
            _ => panic!("Expected Close"),
        }
    }

    #[tokio::test]
    async fn close_action_zero_increment_no_voucher() {
        let mut s = make_session();
        let action = s.close_action(Some(0)).await.unwrap();
        match action {
            SessionAction::Close(p) => {
                assert!(p.voucher.is_none());
            }
            _ => panic!("Expected Close"),
        }
    }
}
