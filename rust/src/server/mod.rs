//! Server-side payment verification for the Solana charge intent.
//!
//! # Quick Start
//!
//! ```ignore
//! use solana_mpp::server::Mpp;
//!
//! let mpp = Mpp::new(solana_mpp::server::Config {
//!     recipient: "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY".to_string(),
//!     ..Default::default()
//! })?;
//!
//! // Generate a charge challenge (returns HTTP 402)
//! let challenge = mpp.charge("0.10")?;
//!
//! // Verify a credential from Authorization header
//! let credential = solana_mpp::PaymentCredential::from_header(&auth_header)?;
//! let receipt = mpp.verify_credential(&credential).await?;
//! ```

use std::sync::Arc;

use solana_pubkey::Pubkey;
use solana_rpc_client::rpc_client::RpcClient;
use solana_signature::Signature;
use solana_transaction::Transaction;
use solana_transaction_status::UiTransactionEncoding;
use std::str::FromStr;

use crate::error::Error;
use crate::protocol::core::{
    compute_challenge_id, Base64UrlJson, PaymentChallenge, PaymentCredential, Receipt,
};
use crate::protocol::intents::ChargeRequest;
use crate::protocol::solana::{programs, CredentialPayload, MethodDetails, Split};
use crate::store::{MemoryStore, Store};

const SECRET_KEY_ENV_VAR: &str = "MPP_SECRET_KEY";
const METHOD_NAME: &str = "solana";

const DEFAULT_REALM: &str = "MPP Payment";

fn detect_secret_key() -> Result<String, Error> {
    std::env::var(SECRET_KEY_ENV_VAR).map_err(|_| {
        Error::InvalidConfig(format!(
            "Missing {SECRET_KEY_ENV_VAR} env var. Set it or pass secret_key explicitly."
        ))
    })
}

fn default_rpc_url(network: &str) -> &'static str {
    match network {
        "devnet" => "https://api.devnet.solana.com",
        "localnet" => "http://localhost:8899",
        _ => "https://api.mainnet-beta.solana.com",
    }
}

// ── Configuration ──

/// Server configuration.
#[derive(Clone)]
pub struct Config {
    /// Base58-encoded recipient public key.
    pub recipient: String,
    /// Currency: "sol" for native, mint address or symbol for SPL tokens.
    pub currency: String,
    /// Token decimals (default: 6 for USDC-like tokens).
    pub decimals: u8,
    /// Solana network: mainnet-beta, devnet, or localnet.
    pub network: String,
    /// RPC URL (overrides default for the network).
    pub rpc_url: Option<String>,
    /// Server secret key for HMAC challenge IDs.
    pub secret_key: Option<String>,
    /// Server realm.
    pub realm: Option<String>,
    /// Whether server pays transaction fees.
    pub fee_payer: bool,
    /// Fee payer signer (if fee_payer is true).
    pub fee_payer_signer: Option<Arc<dyn solana_keychain::SolanaSigner>>,
    /// Replay protection store (defaults to in-memory).
    pub store: Option<Arc<dyn Store>>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            recipient: String::new(),
            currency: "USDC".to_string(),
            decimals: 6,
            network: "mainnet-beta".to_string(),
            rpc_url: None,
            secret_key: None,
            realm: None,
            fee_payer: false,
            fee_payer_signer: None,
            store: None,
        }
    }
}

/// Options for generating a charge challenge.
#[derive(Debug, Clone, Default)]
pub struct ChargeOptions<'a> {
    pub description: Option<&'a str>,
    pub external_id: Option<&'a str>,
    pub expires: Option<&'a str>,
    pub fee_payer: bool,
}

// ── Mpp handler ──

/// Server-side payment handler for Solana.
///
/// Handles challenge generation and credential verification using
/// stateless HMAC-bound challenge IDs.
#[derive(Clone)]
pub struct Mpp {
    rpc: Arc<RpcClient>,
    realm: String,
    secret_key: String,
    currency: String,
    recipient: String,
    decimals: u32,
    network: String,
    fee_payer: bool,
    fee_payer_signer: Option<Arc<dyn solana_keychain::SolanaSigner>>,
    store: Arc<dyn Store>,
}

impl Mpp {
    /// Create a new payment handler from config.
    pub fn new(config: Config) -> Result<Self, Error> {
        if config.recipient.is_empty() {
            return Err(Error::InvalidConfig("recipient is required".into()));
        }
        Pubkey::from_str(&config.recipient)
            .map_err(|e| Error::InvalidConfig(format!("Invalid recipient pubkey: {e}")))?;

        let rpc_url = config
            .rpc_url
            .unwrap_or_else(|| default_rpc_url(&config.network).to_string());
        let secret_key = config.secret_key.map_or_else(detect_secret_key, Ok)?;
        let realm = config.realm.unwrap_or_else(|| DEFAULT_REALM.to_string());
        let store: Arc<dyn Store> = config.store.unwrap_or_else(|| Arc::new(MemoryStore::new()));

        Ok(Mpp {
            rpc: Arc::new(RpcClient::new(rpc_url)),
            realm,
            secret_key,
            currency: config.currency,
            recipient: config.recipient,
            decimals: config.decimals as u32,
            network: config.network,
            fee_payer: config.fee_payer,
            fee_payer_signer: config.fee_payer_signer,
            store,
        })
    }

    // ── Accessors ──

    pub fn realm(&self) -> &str {
        &self.realm
    }

    pub fn currency(&self) -> &str {
        &self.currency
    }

    pub fn recipient(&self) -> &str {
        &self.recipient
    }

    pub fn decimals(&self) -> u32 {
        self.decimals
    }

    // ── Challenge generation ──

    /// Generate a charge challenge for a dollar amount (e.g., `"0.10"`).
    ///
    /// Amount is automatically converted from dollars to base units using
    /// the configured decimals (default: 6).
    pub fn charge(&self, amount: &str) -> Result<PaymentChallenge, Error> {
        self.charge_with_options(amount, ChargeOptions::default())
    }

    /// Generate a charge challenge with additional options.
    pub fn charge_with_options(
        &self,
        amount: &str,
        options: ChargeOptions<'_>,
    ) -> Result<PaymentChallenge, Error> {
        let base_units = crate::protocol::intents::parse_units(amount, self.decimals as u8)?;

        let mut request = ChargeRequest {
            amount: base_units,
            currency: self.currency.clone(),
            recipient: Some(self.recipient.clone()),
            description: options.description.map(|s| s.to_string()),
            external_id: options.external_id.map(|s| s.to_string()),
            ..Default::default()
        };

        // Build Solana-specific method details.
        let mut details = serde_json::Map::new();
        details.insert("network".into(), serde_json::json!(self.network));
        details.insert("decimals".into(), serde_json::json!(self.decimals));

        if options.fee_payer || self.fee_payer {
            details.insert("feePayer".into(), serde_json::json!(true));
            if let Some(ref signer) = self.fee_payer_signer {
                details.insert(
                    "feePayerKey".into(),
                    serde_json::json!(signer.pubkey().to_string()),
                );
            }
        }

        // Pre-fetch blockhash so the client doesn't need an extra RPC call.
        if let Ok(blockhash) = self.rpc.get_latest_blockhash() {
            details.insert(
                "recentBlockhash".into(),
                serde_json::json!(blockhash.to_string()),
            );
        }

        request.method_details = Some(serde_json::Value::Object(details));

        let encoded = Base64UrlJson::from_typed(&request)?;
        let default_expires = crate::expires::minutes(5);
        let expires = options.expires.unwrap_or(&default_expires);

        Ok(PaymentChallenge::with_secret_key_full(
            &self.secret_key,
            &self.realm,
            METHOD_NAME,
            "charge",
            encoded,
            Some(expires),
            None,
            options.description,
            None,
        ))
    }

    /// Generate a charge challenge with explicit base-unit parameters.
    pub fn charge_challenge(&self, request: &ChargeRequest) -> Result<PaymentChallenge, Error> {
        self.charge_challenge_with_options(request, None, None)
    }

    /// Generate a charge challenge from a full request with options.
    pub fn charge_challenge_with_options(
        &self,
        request: &ChargeRequest,
        expires: Option<&str>,
        description: Option<&str>,
    ) -> Result<PaymentChallenge, Error> {
        let encoded = Base64UrlJson::from_typed(request)?;
        let default_expires = crate::expires::minutes(5);
        let expires = expires.unwrap_or(&default_expires);

        Ok(PaymentChallenge::with_secret_key_full(
            &self.secret_key,
            &self.realm,
            METHOD_NAME,
            "charge",
            encoded,
            Some(expires),
            None,
            description,
            None,
        ))
    }

    // ── Verification ──

    /// Verify a payment credential (simple API).
    ///
    /// Decodes the charge request from the echoed challenge automatically.
    pub async fn verify_credential(
        &self,
        credential: &PaymentCredential,
    ) -> Result<Receipt, VerificationError> {
        let request: ChargeRequest = credential
            .challenge
            .request
            .decode()
            .map_err(|e| VerificationError::new(format!("Failed to decode request: {e}")))?;
        self.verify(credential, &request).await
    }

    /// Verify with cross-route protection — ensures the credential matches
    /// the expected charge parameters for this endpoint.
    pub async fn verify_credential_with_expected(
        &self,
        credential: &PaymentCredential,
        expected: &ChargeRequest,
    ) -> Result<Receipt, VerificationError> {
        let request: ChargeRequest = credential
            .challenge
            .request
            .decode()
            .map_err(|e| VerificationError::new(format!("Failed to decode request: {e}")))?;

        if request.amount != expected.amount {
            return Err(VerificationError::credential_mismatch(format!(
                "Amount mismatch: credential has {} but endpoint expects {}",
                request.amount, expected.amount
            )));
        }
        if request.currency != expected.currency {
            return Err(VerificationError::credential_mismatch(format!(
                "Currency mismatch: credential has {} but endpoint expects {}",
                request.currency, expected.currency
            )));
        }
        if request.recipient != expected.recipient {
            return Err(VerificationError::credential_mismatch("Recipient mismatch"));
        }

        self.verify(credential, &request).await
    }

    /// Verify a charge credential with an explicit request.
    pub async fn verify(
        &self,
        credential: &PaymentCredential,
        request: &ChargeRequest,
    ) -> Result<Receipt, VerificationError> {
        // 1. Verify HMAC.
        let expected_id = compute_challenge_id(
            &self.secret_key,
            &self.realm,
            credential.challenge.method.as_str(),
            credential.challenge.intent.as_str(),
            credential.challenge.request.raw(),
            credential.challenge.expires.as_deref(),
            credential.challenge.digest.as_deref(),
            credential.challenge.opaque.as_ref().map(|o| o.raw()),
        );
        if credential.challenge.id != expected_id {
            return Err(VerificationError::credential_mismatch(
                "Challenge ID mismatch — not issued by this server",
            ));
        }

        // 2. Check expiry.
        if let Some(ref expires) = credential.challenge.expires {
            if let Ok(expires_at) =
                time::OffsetDateTime::parse(expires, &time::format_description::well_known::Rfc3339)
            {
                if expires_at <= time::OffsetDateTime::now_utc() {
                    return Err(VerificationError::expired(format!(
                        "Challenge expired at {expires}"
                    )));
                }
            } else {
                return Err(VerificationError::new(
                    "Invalid expires timestamp in challenge",
                ));
            }
        }

        // 3. Deserialize the credential payload.
        let payload: CredentialPayload = serde_json::from_value(credential.payload.clone())
            .map_err(|e| {
                VerificationError::invalid_payload(format!("Invalid credential payload: {e}"))
            })?;

        let method_details: MethodDetails = request
            .method_details
            .as_ref()
            .map(|v| serde_json::from_value(v.clone()))
            .transpose()
            .map_err(|e| {
                VerificationError::invalid_payload(format!("Invalid method details: {e}"))
            })?
            .unwrap_or_default();

        // 4. Settle — pull or push mode.
        let signature_str = match payload {
            CredentialPayload::Transaction { ref transaction } => {
                self.verify_pull(transaction, request, &method_details)
                    .await?
            }
            CredentialPayload::Signature { ref signature } => {
                self.verify_push(signature, request, &method_details)?
            }
        };

        // 5. Replay protection.
        let consumed_key = format!("solana-charge:consumed:{signature_str}");
        if self
            .store
            .get(&consumed_key)
            .await
            .map_err(|e| VerificationError::new(format!("Store error: {e}")))?
            .is_some()
        {
            return Err(VerificationError::signature_consumed(
                "Transaction signature already consumed",
            ));
        }
        self.store
            .put(&consumed_key, serde_json::json!(true))
            .await
            .map_err(|e| VerificationError::new(format!("Store error: {e}")))?;

        Ok(Receipt::success(METHOD_NAME, &signature_str)
            .with_challenge_id(credential.challenge.id.clone()))
    }

    // ── Settlement ──

    /// Pull mode: deserialize tx, optionally co-sign, simulate, broadcast, verify.
    async fn verify_pull(
        &self,
        transaction_b64: &str,
        request: &ChargeRequest,
        method_details: &MethodDetails,
    ) -> Result<String, VerificationError> {
        let tx_bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, transaction_b64)
                .map_err(|e| {
                    VerificationError::invalid_payload(format!("Invalid base64 transaction: {e}"))
                })?;

        let mut tx: Transaction = bincode::deserialize(&tx_bytes)
            .map_err(|e| VerificationError::invalid_payload(format!("Invalid transaction: {e}")))?;

        // Co-sign if server is fee payer.
        if method_details.fee_payer.unwrap_or(false) {
            let signer = self.fee_payer_signer.as_ref().ok_or_else(|| {
                VerificationError::new("Fee payer enabled but no signer configured")
            })?;
            let msg_data = tx.message_data();
            let sig_bytes = signer
                .sign_message(&msg_data)
                .await
                .map_err(|e| VerificationError::new(format!("Fee payer signing failed: {e}")))?;
            let sig = Signature::from(<[u8; 64]>::from(sig_bytes));
            let fee_payer_pubkey = signer.pubkey();
            let idx = tx
                .message
                .account_keys
                .iter()
                .position(|k| k == &fee_payer_pubkey)
                .ok_or_else(|| {
                    VerificationError::invalid_payload(
                        "Fee payer not found in transaction accounts",
                    )
                })?;
            tx.signatures[idx] = sig;
        }

        // Simulate before broadcasting (prevent fee loss).
        let sim = self
            .rpc
            .simulate_transaction(&tx)
            .map_err(|e| VerificationError::network_error(format!("Simulation RPC error: {e}")))?;
        if let Some(err) = sim.value.err {
            return Err(VerificationError::transaction_failed(format!(
                "Simulation failed: {err}"
            )));
        }

        // Broadcast.
        let signature = self
            .rpc
            .send_and_confirm_transaction(&tx)
            .map_err(|e| VerificationError::network_error(format!("Broadcast failed: {e}")))?;

        let sig_str = signature.to_string();

        // Verify on-chain.
        self.verify_on_chain(&sig_str, request, method_details)?;

        Ok(sig_str)
    }

    /// Push mode: fetch tx by signature, verify on-chain.
    fn verify_push(
        &self,
        signature_str: &str,
        request: &ChargeRequest,
        method_details: &MethodDetails,
    ) -> Result<String, VerificationError> {
        self.verify_on_chain(signature_str, request, method_details)?;
        Ok(signature_str.to_string())
    }

    /// Verify that the on-chain transaction matches the expected charge parameters.
    fn verify_on_chain(
        &self,
        signature_str: &str,
        request: &ChargeRequest,
        method_details: &MethodDetails,
    ) -> Result<(), VerificationError> {
        let signature = Signature::from_str(signature_str)
            .map_err(|e| VerificationError::invalid_payload(format!("Invalid signature: {e}")))?;

        let tx = self
            .rpc
            .get_transaction(&signature, UiTransactionEncoding::JsonParsed)
            .map_err(|e| {
                if e.to_string().contains("not found") {
                    VerificationError::not_found("Transaction not found or not yet confirmed")
                } else {
                    VerificationError::network_error(format!("RPC error: {e}"))
                }
            })?;

        // Check for on-chain error.
        if let Some(meta) = &tx.transaction.meta {
            if meta.err.is_some() {
                return Err(VerificationError::transaction_failed(format!(
                    "Transaction failed: {:?}",
                    meta.err
                )));
            }
        }

        let total_amount: u64 = request.amount.parse().map_err(|_| {
            VerificationError::invalid_amount(format!("Invalid amount: {}", request.amount))
        })?;

        let splits = method_details.splits.as_deref().unwrap_or(&[]);
        let splits_total: u64 = splits
            .iter()
            .filter_map(|s| s.amount.parse::<u64>().ok())
            .sum();
        let primary_amount = total_amount.checked_sub(splits_total).ok_or_else(|| {
            VerificationError::invalid_amount("Split amounts exceed total amount")
        })?;
        if primary_amount == 0 {
            return Err(VerificationError::invalid_amount(
                "Primary amount is zero after splits",
            ));
        }

        let recipient = request.recipient.as_deref().ok_or_else(|| {
            VerificationError::invalid_recipient("No recipient in charge request")
        })?;

        let is_native_sol = request.currency.to_uppercase() == "SOL";

        let instructions = extract_parsed_instructions(&tx)?;

        if is_native_sol {
            verify_sol_transfers(&instructions, recipient, primary_amount, splits)?;
        } else {
            verify_spl_transfers(&instructions, recipient, primary_amount, splits)?;
        }

        Ok(())
    }
}

// ── On-chain verification helpers ──

fn verify_sol_transfers(
    instructions: &[serde_json::Value],
    recipient: &str,
    primary_amount: u64,
    splits: &[Split],
) -> Result<(), VerificationError> {
    find_sol_transfer(instructions, recipient, primary_amount)?;
    for split in splits {
        let amt: u64 = split
            .amount
            .parse()
            .map_err(|_| VerificationError::invalid_amount("Invalid split amount"))?;
        find_sol_transfer(instructions, &split.recipient, amt).map_err(|_| {
            VerificationError::invalid_amount(format!(
                "Missing split transfer to {}",
                split.recipient
            ))
        })?;
    }
    Ok(())
}

fn find_sol_transfer(
    instructions: &[serde_json::Value],
    recipient: &str,
    amount: u64,
) -> Result<(), VerificationError> {
    for ix in instructions {
        if let Some(parsed) = ix.get("parsed").and_then(|p| p.as_object()) {
            if parsed.get("type").and_then(|t| t.as_str()) != Some("transfer") {
                continue;
            }
            if let Some(info) = parsed.get("info").and_then(|i| i.as_object()) {
                let dest = info
                    .get("destination")
                    .and_then(|d| d.as_str())
                    .unwrap_or("");
                let lamports = info.get("lamports").and_then(|l| l.as_u64()).unwrap_or(0);
                if dest == recipient && lamports == amount {
                    return Ok(());
                }
            }
        }
    }
    Err(VerificationError::invalid_amount(format!(
        "No matching SOL transfer of {amount} lamports to {recipient}"
    )))
}

fn verify_spl_transfers(
    instructions: &[serde_json::Value],
    recipient: &str,
    primary_amount: u64,
    splits: &[Split],
) -> Result<(), VerificationError> {
    find_spl_transfer(instructions, recipient, primary_amount)?;
    for split in splits {
        let amt: u64 = split
            .amount
            .parse()
            .map_err(|_| VerificationError::invalid_amount("Invalid split amount"))?;
        find_spl_transfer(instructions, &split.recipient, amt).map_err(|_| {
            VerificationError::invalid_amount(format!(
                "Missing split SPL transfer to {}",
                split.recipient
            ))
        })?;
    }
    Ok(())
}

fn find_spl_transfer(
    instructions: &[serde_json::Value],
    recipient: &str,
    amount: u64,
) -> Result<(), VerificationError> {
    for ix in instructions {
        let program = ix.get("programId").and_then(|p| p.as_str()).unwrap_or("");
        if program != programs::TOKEN_PROGRAM && program != programs::TOKEN_2022_PROGRAM {
            continue;
        }
        if let Some(parsed) = ix.get("parsed").and_then(|p| p.as_object()) {
            if parsed.get("type").and_then(|t| t.as_str()) != Some("transferChecked") {
                continue;
            }
            if let Some(info) = parsed.get("info").and_then(|i| i.as_object()) {
                let token_amount = info
                    .get("tokenAmount")
                    .and_then(|t| t.as_object())
                    .and_then(|t| t.get("amount"))
                    .and_then(|a| a.as_str())
                    .and_then(|a| a.parse::<u64>().ok())
                    .unwrap_or(0);
                if token_amount == amount {
                    // Verify ATA belongs to expected recipient by deriving it.
                    let dest = info
                        .get("destination")
                        .and_then(|d| d.as_str())
                        .unwrap_or("");
                    let mint = info.get("mint").and_then(|m| m.as_str()).unwrap_or("");
                    if verify_ata_owner(dest, recipient, mint, program) {
                        return Ok(());
                    }
                }
            }
        }
    }
    Err(VerificationError::invalid_amount(format!(
        "No matching SPL transferChecked of {amount} to {recipient}"
    )))
}

/// Verify ATA derivation: PDA([owner, token_program, mint], ATA_PROGRAM) == ata_address.
fn verify_ata_owner(
    ata_address: &str,
    expected_owner: &str,
    mint: &str,
    token_program: &str,
) -> bool {
    let Ok(owner) = Pubkey::from_str(expected_owner) else {
        return false;
    };
    let Ok(mint_pk) = Pubkey::from_str(mint) else {
        return false;
    };
    let Ok(tp) = Pubkey::from_str(token_program) else {
        return false;
    };
    let Ok(ata_pk) = Pubkey::from_str(ata_address) else {
        return false;
    };
    let ata_program = Pubkey::from_str(programs::ASSOCIATED_TOKEN_PROGRAM).unwrap();
    let (expected_ata, _) = Pubkey::find_program_address(
        &[owner.as_ref(), tp.as_ref(), mint_pk.as_ref()],
        &ata_program,
    );
    expected_ata == ata_pk
}

/// Extract parsed instructions from an encoded transaction.
fn extract_parsed_instructions(
    tx: &solana_transaction_status::EncodedConfirmedTransactionWithStatusMeta,
) -> Result<Vec<serde_json::Value>, VerificationError> {
    let tx_json = serde_json::to_value(&tx.transaction.transaction)
        .map_err(|e| VerificationError::new(format!("Failed to serialize transaction: {e}")))?;

    let mut all = tx_json
        .get("message")
        .and_then(|m| m.get("instructions"))
        .and_then(|i| i.as_array())
        .cloned()
        .unwrap_or_default();

    // Include inner instructions.
    if let Some(meta) = &tx.transaction.meta {
        let meta_json = serde_json::to_value(meta)
            .map_err(|e| VerificationError::new(format!("Failed to serialize meta: {e}")))?;
        if let Some(inner) = meta_json
            .get("innerInstructions")
            .and_then(|i| i.as_array())
        {
            for group in inner {
                if let Some(ixs) = group.get("instructions").and_then(|i| i.as_array()) {
                    all.extend(ixs.iter().cloned());
                }
            }
        }
    }

    Ok(all)
}

// ── VerificationError ──

/// Error returned when payment verification fails.
#[derive(Debug, Clone)]
pub struct VerificationError {
    pub message: String,
    pub code: Option<&'static str>,
    pub retryable: bool,
}

impl VerificationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            retryable: false,
        }
    }

    fn with_code(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
            retryable: false,
        }
    }

    fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn expired(msg: impl Into<String>) -> Self {
        Self::with_code(msg, "payment-expired")
    }

    pub fn invalid_amount(msg: impl Into<String>) -> Self {
        Self::with_code(msg, "verification-failed")
    }

    pub fn invalid_recipient(msg: impl Into<String>) -> Self {
        Self::with_code(msg, "verification-failed")
    }

    pub fn transaction_failed(msg: impl Into<String>) -> Self {
        Self::with_code(msg, "verification-failed")
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::with_code(msg, "verification-failed")
    }

    pub fn network_error(msg: impl Into<String>) -> Self {
        Self::with_code(msg, "verification-failed").retryable()
    }

    pub fn credential_mismatch(msg: impl Into<String>) -> Self {
        Self::with_code(msg, "malformed-credential")
    }

    pub fn invalid_payload(msg: impl Into<String>) -> Self {
        Self::with_code(msg, "malformed-credential")
    }

    pub fn signature_consumed(msg: impl Into<String>) -> Self {
        Self::with_code(msg, "signature-consumed")
    }
}

impl std::fmt::Display for VerificationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(code) = self.code {
            write!(f, "[{code}] {}", self.message)
        } else {
            write!(f, "{}", self.message)
        }
    }
}

impl std::error::Error for VerificationError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ata_derivation_verification() {
        // Known ATA derivation for a well-known pubkey/mint combo.
        let owner = "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY";
        let mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC mainnet
        let tp = programs::TOKEN_PROGRAM;

        let owner_pk = Pubkey::from_str(owner).unwrap();
        let mint_pk = Pubkey::from_str(mint).unwrap();
        let tp_pk = Pubkey::from_str(tp).unwrap();
        let ata_program = Pubkey::from_str(programs::ASSOCIATED_TOKEN_PROGRAM).unwrap();
        let (expected_ata, _) = Pubkey::find_program_address(
            &[owner_pk.as_ref(), tp_pk.as_ref(), mint_pk.as_ref()],
            &ata_program,
        );

        assert!(verify_ata_owner(&expected_ata.to_string(), owner, mint, tp));
        assert!(!verify_ata_owner(
            "11111111111111111111111111111111",
            owner,
            mint,
            tp
        ));
    }
}
