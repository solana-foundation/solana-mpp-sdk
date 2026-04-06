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

pub mod html;

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
    /// Enable HTML payment link pages for browser requests.
    pub html: bool,
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
            html: false,
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
    rpc_url: String,
    realm: String,
    secret_key: String,
    currency: String,
    recipient: String,
    decimals: u32,
    network: String,
    fee_payer: bool,
    fee_payer_signer: Option<Arc<dyn solana_keychain::SolanaSigner>>,
    store: Arc<dyn Store>,
    html: bool,
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
            rpc: Arc::new(RpcClient::new(rpc_url.clone())),
            rpc_url,
            realm,
            secret_key,
            currency: config.currency,
            recipient: config.recipient,
            decimals: config.decimals as u32,
            network: config.network,
            fee_payer: config.fee_payer,
            fee_payer_signer: config.fee_payer_signer,
            store,
            html: config.html,
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

    pub fn network(&self) -> &str {
        &self.network
    }

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    /// Whether HTML payment link pages are enabled.
    pub fn html_enabled(&self) -> bool {
        self.html
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

        // Include token program so the client doesn't need to look up the mint account.
        if self.currency.to_uppercase() != "SOL" {
            details.insert(
                "tokenProgram".into(),
                serde_json::json!(programs::TOKEN_PROGRAM),
            );
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

        // 5. Replay protection (atomic check-and-consume).
        let consumed_key = format!("solana-charge:consumed:{signature_str}");
        let inserted = self
            .store
            .put_if_absent(&consumed_key, serde_json::json!(true))
            .await
            .map_err(|e| VerificationError::new(format!("Store error: {e}")))?;
        if !inserted {
            return Err(VerificationError::signature_consumed(
                "Transaction signature already consumed",
            ));
        }

        Ok(Receipt::success(
            METHOD_NAME,
            &signature_str,
            credential.challenge.id.clone(),
        ))
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

        let t0 = std::time::Instant::now();

        // Verify the transaction instructions BEFORE co-signing or broadcasting.
        verify_transaction_pre_broadcast(&tx, request, method_details)?;
        tracing::info!(elapsed_ms = %t0.elapsed().as_millis(), step = "pre_broadcast_check", "verify_pull");

        // Co-sign if server is fee payer (only after verification passes).
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
        tracing::info!(elapsed_ms = %t0.elapsed().as_millis(), step = "cosign", "verify_pull");

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
        tracing::info!(elapsed_ms = %t0.elapsed().as_millis(), step = "simulate", "verify_pull");

        // Broadcast and wait for Confirmed commitment (not Finalized).
        let signature = self
            .rpc
            .send_transaction(&tx)
            .map_err(|e| VerificationError::network_error(format!("Broadcast failed: {e}")))?;
        tracing::info!(elapsed_ms = %t0.elapsed().as_millis(), step = "send", "verify_pull");

        // Poll for confirmed status (typically ~400ms on devnet/surfnet).
        use solana_commitment_config::CommitmentConfig;
        let commitment = CommitmentConfig::confirmed();
        for _ in 0..30 {
            match self
                .rpc
                .confirm_transaction_with_commitment(&signature, commitment)
            {
                Ok(resp) if resp.value => {
                    tracing::info!(elapsed_ms = %t0.elapsed().as_millis(), step = "confirmed", "verify_pull");
                    return Ok(signature.to_string());
                }
                _ => std::thread::sleep(std::time::Duration::from_millis(200)),
            }
        }

        Err(VerificationError::network_error(
            "Transaction not confirmed within timeout".to_string(),
        ))
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

// ── Pre-broadcast verification ──
//
// Inspects the raw Transaction instructions to verify amounts and recipients
// BEFORE broadcasting, preventing fund loss on invalid credentials.

fn verify_transaction_pre_broadcast(
    tx: &Transaction,
    request: &ChargeRequest,
    method_details: &MethodDetails,
) -> Result<(), VerificationError> {
    let splits = method_details.splits.as_deref().unwrap_or(&[]);
    if splits.len() > 8 {
        return Err(VerificationError::too_many_splits(format!(
            "Too many splits: {} (maximum 8)",
            splits.len()
        )));
    }

    let total_amount: u64 = request.amount.parse().map_err(|_| {
        VerificationError::invalid_amount(format!("Invalid amount: {}", request.amount))
    })?;
    let splits_total: u64 = splits
        .iter()
        .filter_map(|s| s.amount.parse::<u64>().ok())
        .sum();
    let primary_amount = total_amount
        .checked_sub(splits_total)
        .ok_or_else(|| VerificationError::invalid_amount("Split amounts exceed total amount"))?;
    if primary_amount == 0 {
        return Err(VerificationError::invalid_amount(
            "Primary amount is zero after splits",
        ));
    }

    let recipient = request
        .recipient
        .as_deref()
        .ok_or_else(|| VerificationError::invalid_recipient("No recipient in charge request"))?;
    let recipient_pk = Pubkey::from_str(recipient)
        .map_err(|e| VerificationError::invalid_recipient(format!("Invalid recipient: {e}")))?;

    let is_native_sol = request.currency.to_uppercase() == "SOL";
    let account_keys = &tx.message.account_keys;

    if is_native_sol {
        verify_sol_transfer_instructions(tx, account_keys, &recipient_pk, primary_amount)?;
        for split in splits {
            let split_pk = Pubkey::from_str(&split.recipient).map_err(|e| {
                VerificationError::invalid_recipient(format!("Invalid split recipient: {e}"))
            })?;
            let amt: u64 = split
                .amount
                .parse()
                .map_err(|_| VerificationError::invalid_amount("Invalid split amount"))?;
            verify_sol_transfer_instructions(tx, account_keys, &split_pk, amt)?;
        }
    } else {
        verify_spl_transfer_instructions(tx, account_keys, &recipient_pk, primary_amount)?;
        for split in splits {
            let split_pk = Pubkey::from_str(&split.recipient).map_err(|e| {
                VerificationError::invalid_recipient(format!("Invalid split recipient: {e}"))
            })?;
            let amt: u64 = split
                .amount
                .parse()
                .map_err(|_| VerificationError::invalid_amount("Invalid split amount"))?;
            verify_spl_transfer_instructions(tx, account_keys, &split_pk, amt)?;
        }
    }

    Ok(())
}

/// Check that the transaction contains a System Program transfer of `amount` to `recipient`.
fn verify_sol_transfer_instructions(
    tx: &Transaction,
    account_keys: &[Pubkey],
    recipient: &Pubkey,
    amount: u64,
) -> Result<(), VerificationError> {
    let system_program = Pubkey::from_str(programs::SYSTEM_PROGRAM).unwrap();

    for ix in &tx.message.instructions {
        let program_id = account_keys
            .get(ix.program_id_index as usize)
            .ok_or_else(|| VerificationError::invalid_payload("Invalid program_id_index"))?;
        if program_id != &system_program {
            continue;
        }
        // System program Transfer instruction: 4 bytes type (2u32 LE) + 8 bytes amount (u64 LE)
        if ix.data.len() < 12 {
            continue;
        }
        let ix_type = u32::from_le_bytes(ix.data[0..4].try_into().unwrap());
        if ix_type != 2 {
            // 2 = Transfer
            continue;
        }
        let ix_amount = u64::from_le_bytes(ix.data[4..12].try_into().unwrap());
        // destination is account_keys[accounts[1]]
        if ix.accounts.len() < 2 {
            continue;
        }
        let dest = account_keys
            .get(ix.accounts[1] as usize)
            .ok_or_else(|| VerificationError::invalid_payload("Invalid destination index"))?;
        if dest == recipient && ix_amount == amount {
            return Ok(());
        }
    }
    Err(VerificationError::invalid_amount(format!(
        "No matching SOL transfer of {amount} lamports to {recipient}"
    )))
}

/// Check that the transaction contains an SPL Token transferChecked of `amount` to `recipient`'s ATA.
fn verify_spl_transfer_instructions(
    tx: &Transaction,
    account_keys: &[Pubkey],
    recipient: &Pubkey,
    amount: u64,
) -> Result<(), VerificationError> {
    let token_program = Pubkey::from_str(programs::TOKEN_PROGRAM).unwrap();
    let token_2022_program = Pubkey::from_str(programs::TOKEN_2022_PROGRAM).unwrap();
    let ata_program = Pubkey::from_str(programs::ASSOCIATED_TOKEN_PROGRAM).unwrap();

    for ix in &tx.message.instructions {
        let program_id = account_keys
            .get(ix.program_id_index as usize)
            .ok_or_else(|| VerificationError::invalid_payload("Invalid program_id_index"))?;
        if program_id != &token_program && program_id != &token_2022_program {
            continue;
        }
        // SPL Token TransferChecked instruction:
        //   data[0] = 12 (instruction type)
        //   data[1..9] = amount (u64 LE)
        //   data[9] = decimals (u8)
        // Accounts: [source, mint, destination, authority, ...]
        if ix.data.is_empty() || ix.data[0] != 12 {
            continue;
        }
        if ix.data.len() < 10 || ix.accounts.len() < 4 {
            continue;
        }
        let ix_amount = u64::from_le_bytes(ix.data[1..9].try_into().unwrap());
        if ix_amount != amount {
            continue;
        }
        // Verify the destination ATA belongs to the recipient
        let dest_ata = account_keys
            .get(ix.accounts[2] as usize)
            .ok_or_else(|| VerificationError::invalid_payload("Invalid destination index"))?;
        let mint = account_keys
            .get(ix.accounts[1] as usize)
            .ok_or_else(|| VerificationError::invalid_payload("Invalid mint index"))?;
        // Derive expected ATA: PDA([owner, token_program, mint], ata_program)
        let (expected_ata, _) = Pubkey::find_program_address(
            &[recipient.as_ref(), program_id.as_ref(), mint.as_ref()],
            &ata_program,
        );
        if dest_ata == &expected_ata {
            return Ok(());
        }
    }
    Err(VerificationError::invalid_amount(format!(
        "No matching SPL transferChecked of {amount} to {recipient}"
    )))
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
///
/// Includes RFC 9457 Problem Details fields for spec-compliant error responses.
#[derive(Debug, Clone)]
pub struct VerificationError {
    pub message: String,
    pub code: Option<&'static str>,
    pub retryable: bool,
    /// RFC 9457 `type` URI identifying the error class.
    pub type_uri: &'static str,
    /// RFC 9457 short human-readable summary.
    pub title: String,
    /// RFC 9457 HTTP status code (402 for payment errors).
    pub status: u16,
}

impl VerificationError {
    pub fn new(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            title: "Payment Verification Error".to_string(),
            message,
            code: None,
            retryable: false,
            type_uri: "tag:paymentauth.org,2024:verification-failed",
            status: 402,
        }
    }

    fn with_code(
        message: impl Into<String>,
        code: &'static str,
        title: &str,
        type_uri: &'static str,
    ) -> Self {
        let message = message.into();
        Self {
            title: title.to_string(),
            message,
            code: Some(code),
            retryable: false,
            type_uri,
            status: 402,
        }
    }

    fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn expired(msg: impl Into<String>) -> Self {
        Self::with_code(
            msg,
            "payment-expired",
            "Payment Challenge Expired",
            "tag:paymentauth.org,2024:payment-expired",
        )
    }

    pub fn invalid_amount(msg: impl Into<String>) -> Self {
        Self::with_code(
            msg,
            "verification-failed",
            "Verification Failed",
            "tag:paymentauth.org,2024:verification-failed",
        )
    }

    pub fn invalid_recipient(msg: impl Into<String>) -> Self {
        Self::with_code(
            msg,
            "verification-failed",
            "Verification Failed",
            "tag:paymentauth.org,2024:verification-failed",
        )
    }

    pub fn transaction_failed(msg: impl Into<String>) -> Self {
        Self::with_code(
            msg,
            "verification-failed",
            "Transaction Failed",
            "tag:paymentauth.org,2024:verification-failed",
        )
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::with_code(
            msg,
            "verification-failed",
            "Transaction Not Found",
            "tag:paymentauth.org,2024:verification-failed",
        )
    }

    pub fn network_error(msg: impl Into<String>) -> Self {
        Self::with_code(
            msg,
            "verification-failed",
            "Network Error",
            "tag:paymentauth.org,2024:verification-failed",
        )
        .retryable()
    }

    pub fn credential_mismatch(msg: impl Into<String>) -> Self {
        Self::with_code(
            msg,
            "malformed-credential",
            "Malformed Credential",
            "tag:paymentauth.org,2024:malformed-credential",
        )
    }

    pub fn invalid_payload(msg: impl Into<String>) -> Self {
        Self::with_code(
            msg,
            "malformed-credential",
            "Invalid Payload",
            "tag:paymentauth.org,2024:malformed-credential",
        )
    }

    pub fn signature_consumed(msg: impl Into<String>) -> Self {
        Self::with_code(
            msg,
            "signature-consumed",
            "Signature Already Consumed",
            "tag:paymentauth.org,2024:signature-consumed",
        )
    }

    pub fn too_many_splits(msg: impl Into<String>) -> Self {
        Self::with_code(
            msg,
            "verification-failed",
            "Too Many Splits",
            "tag:paymentauth.org,2024:verification-failed",
        )
    }

    /// Return an RFC 9457 Problem Details JSON object.
    pub fn to_problem_json(&self) -> serde_json::Value {
        let mut obj = serde_json::json!({
            "type": self.type_uri,
            "title": self.title,
            "status": self.status,
            "detail": self.message,
        });
        if let Some(code) = self.code {
            obj["code"] = serde_json::Value::String(code.to_string());
        }
        obj
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

    // ── Helpers for building test transactions ──

    use solana_hash::Hash;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_message::Message;

    fn system_program_id() -> Pubkey {
        Pubkey::from_str(programs::SYSTEM_PROGRAM).unwrap()
    }
    fn token_program_id() -> Pubkey {
        Pubkey::from_str(programs::TOKEN_PROGRAM).unwrap()
    }
    fn ata_program_id() -> Pubkey {
        Pubkey::from_str(programs::ASSOCIATED_TOKEN_PROGRAM).unwrap()
    }

    /// Build a raw System Program transfer instruction.
    fn system_transfer_ix(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
        let mut data = Vec::with_capacity(12);
        data.extend_from_slice(&2u32.to_le_bytes()); // Transfer = 2
        data.extend_from_slice(&lamports.to_le_bytes());
        Instruction {
            program_id: system_program_id(),
            accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
            data,
        }
    }

    /// Build a raw SPL Token transferChecked instruction.
    fn spl_transfer_checked_ix(
        source: &Pubkey,
        mint: &Pubkey,
        destination: &Pubkey,
        authority: &Pubkey,
        amount: u64,
        decimals: u8,
    ) -> Instruction {
        let mut data = Vec::with_capacity(10);
        data.push(12); // TransferChecked = 12
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(decimals);
        Instruction {
            program_id: token_program_id(),
            accounts: vec![
                AccountMeta::new(*source, false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new(*destination, false),
                AccountMeta::new_readonly(*authority, true),
            ],
            data,
        }
    }

    fn dummy_tx(instructions: Vec<Instruction>, payer: &Pubkey) -> Transaction {
        let message = Message::new_with_blockhash(&instructions, Some(payer), &Hash::default());
        Transaction {
            signatures: vec![Signature::default(); message.header.num_required_signatures as usize],
            message,
        }
    }

    fn charge_request(amount: u64, currency: &str, recipient: &Pubkey) -> ChargeRequest {
        ChargeRequest {
            amount: amount.to_string(),
            currency: currency.to_string(),
            recipient: Some(recipient.to_string()),
            ..Default::default()
        }
    }

    // ── Pre-broadcast SOL verification tests ──

    #[test]
    fn sol_transfer_correct_amount_passes() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let amount = 1_000_000u64;

        let tx = dummy_tx(
            vec![system_transfer_ix(&sender, &recipient, amount)],
            &sender,
        );
        let request = charge_request(amount, "SOL", &recipient);
        let method_details = MethodDetails::default();

        assert!(verify_transaction_pre_broadcast(&tx, &request, &method_details).is_ok());
    }

    #[test]
    fn sol_transfer_wrong_amount_rejected() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();

        let tx = dummy_tx(
            vec![system_transfer_ix(&sender, &recipient, 1)], // 1 lamport
            &sender,
        );
        let request = charge_request(1_000_000, "SOL", &recipient); // expects 1M
        let method_details = MethodDetails::default();

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(err.message.contains("No matching SOL transfer"));
    }

    #[test]
    fn sol_transfer_wrong_recipient_rejected() {
        let sender = Pubkey::new_unique();
        let wrong_recipient = Pubkey::new_unique();
        let real_recipient = Pubkey::new_unique();
        let amount = 1_000_000u64;

        let tx = dummy_tx(
            vec![system_transfer_ix(&sender, &wrong_recipient, amount)],
            &sender,
        );
        let request = charge_request(amount, "SOL", &real_recipient);
        let method_details = MethodDetails::default();

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(err.message.contains("No matching SOL transfer"));
    }

    #[test]
    fn sol_transfer_no_transfer_instruction_rejected() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();

        // Empty transaction (no instructions)
        let tx = dummy_tx(vec![], &sender);
        let request = charge_request(1_000_000, "SOL", &recipient);
        let method_details = MethodDetails::default();

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(err.message.contains("No matching SOL transfer"));
    }

    #[test]
    fn sol_transfer_among_other_instructions_passes() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let amount = 500_000u64;

        // Compute budget + transfer + another random instruction
        let compute_budget_ix = Instruction {
            program_id: Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap(),
            accounts: vec![],
            data: vec![0; 5],
        };

        let tx = dummy_tx(
            vec![
                compute_budget_ix,
                system_transfer_ix(&sender, &recipient, amount),
            ],
            &sender,
        );
        let request = charge_request(amount, "SOL", &recipient);
        let method_details = MethodDetails::default();

        assert!(verify_transaction_pre_broadcast(&tx, &request, &method_details).is_ok());
    }

    // ── Pre-broadcast SPL verification tests ──

    #[test]
    fn spl_transfer_correct_amount_passes() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let mint = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();
        let amount = 1_000_000u64; // 1 USDC

        let tp = token_program_id();
        let source_ata = derive_ata(&sender, &mint, &tp);
        let dest_ata = derive_ata(&recipient, &mint, &tp);

        let tx = dummy_tx(
            vec![spl_transfer_checked_ix(
                &source_ata,
                &mint,
                &dest_ata,
                &sender,
                amount,
                6,
            )],
            &sender,
        );
        let request = charge_request(amount, "USDC", &recipient);
        let method_details = MethodDetails::default();

        assert!(verify_transaction_pre_broadcast(&tx, &request, &method_details).is_ok());
    }

    #[test]
    fn spl_transfer_wrong_amount_rejected() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let mint = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();

        let tp = token_program_id();
        let source_ata = derive_ata(&sender, &mint, &tp);
        let dest_ata = derive_ata(&recipient, &mint, &tp);

        let tx = dummy_tx(
            vec![spl_transfer_checked_ix(
                &source_ata,
                &mint,
                &dest_ata,
                &sender,
                1, // wrong: 1 base unit
                6,
            )],
            &sender,
        );
        let request = charge_request(1_000_000, "USDC", &recipient); // expects 1M
        let method_details = MethodDetails::default();

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(err.message.contains("No matching SPL transferChecked"));
    }

    #[test]
    fn spl_transfer_wrong_recipient_rejected() {
        let sender = Pubkey::new_unique();
        let wrong_recipient = Pubkey::new_unique();
        let real_recipient = Pubkey::new_unique();
        let mint = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();
        let amount = 1_000_000u64;

        let tp = token_program_id();
        let source_ata = derive_ata(&sender, &mint, &tp);
        let wrong_dest_ata = derive_ata(&wrong_recipient, &mint, &tp);

        let tx = dummy_tx(
            vec![spl_transfer_checked_ix(
                &source_ata,
                &mint,
                &wrong_dest_ata,
                &sender,
                amount,
                6,
            )],
            &sender,
        );
        let request = charge_request(amount, "USDC", &real_recipient);
        let method_details = MethodDetails::default();

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(err.message.contains("No matching SPL transferChecked"));
    }

    #[test]
    fn spl_transfer_with_ata_creation_passes() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let mint = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();
        let amount = 1_000_000u64;

        let tp = token_program_id();
        let source_ata = derive_ata(&sender, &mint, &tp);
        let dest_ata = derive_ata(&recipient, &mint, &tp);

        // Simulate: create_ata_idempotent + transfer_checked
        let create_ata_ix = Instruction {
            program_id: ata_program_id(),
            accounts: vec![
                AccountMeta::new(sender, true),
                AccountMeta::new(dest_ata, false),
                AccountMeta::new_readonly(recipient, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(system_program_id(), false),
                AccountMeta::new_readonly(tp, false),
            ],
            data: vec![1], // CreateIdempotent
        };

        let tx = dummy_tx(
            vec![
                create_ata_ix,
                spl_transfer_checked_ix(&source_ata, &mint, &dest_ata, &sender, amount, 6),
            ],
            &sender,
        );
        let request = charge_request(amount, "USDC", &recipient);
        let method_details = MethodDetails::default();

        assert!(verify_transaction_pre_broadcast(&tx, &request, &method_details).is_ok());
    }

    #[test]
    fn zero_primary_amount_rejected() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();

        let tx = dummy_tx(vec![], &sender);
        let request = charge_request(0, "SOL", &recipient);
        let method_details = MethodDetails::default();

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(
            err.message.contains("Primary amount is zero")
                || err.message.contains("Invalid amount")
        );
    }

    #[test]
    fn missing_recipient_rejected() {
        let sender = Pubkey::new_unique();
        let tx = dummy_tx(vec![], &sender);
        let request = ChargeRequest {
            amount: "1000000".to_string(),
            currency: "SOL".to_string(),
            recipient: None,
            ..Default::default()
        };
        let method_details = MethodDetails::default();

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(err.message.contains("No recipient"));
    }

    fn derive_ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
        let ata_program = ata_program_id();
        let (ata, _) = Pubkey::find_program_address(
            &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
            &ata_program,
        );
        ata
    }

    // ── Helper: create an Mpp instance for testing ──

    const TEST_SECRET: &str = "test-secret-key-for-unit-tests";
    const TEST_RECIPIENT: &str = "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY";

    fn test_mpp() -> Mpp {
        Mpp::new(Config {
            recipient: TEST_RECIPIENT.to_string(),
            secret_key: Some(TEST_SECRET.to_string()),
            network: "devnet".to_string(),
            ..Default::default()
        })
        .unwrap()
    }

    fn test_mpp_sol() -> Mpp {
        Mpp::new(Config {
            recipient: TEST_RECIPIENT.to_string(),
            secret_key: Some(TEST_SECRET.to_string()),
            currency: "SOL".to_string(),
            decimals: 9,
            network: "devnet".to_string(),
            ..Default::default()
        })
        .unwrap()
    }

    // ── Mpp::new() config validation tests ──

    #[test]
    fn new_missing_recipient_errors() {
        let err = Mpp::new(Config {
            recipient: String::new(),
            secret_key: Some("key".to_string()),
            ..Default::default()
        })
        .err()
        .expect("should fail");
        assert!(
            err.to_string().contains("recipient is required"),
            "got: {err}"
        );
    }

    #[test]
    fn new_invalid_recipient_pubkey_errors() {
        let err = Mpp::new(Config {
            recipient: "not-a-valid-pubkey!!!".to_string(),
            secret_key: Some("key".to_string()),
            ..Default::default()
        })
        .err()
        .expect("should fail");
        assert!(
            err.to_string().contains("Invalid recipient pubkey"),
            "got: {err}"
        );
    }

    #[test]
    fn new_missing_secret_key_without_env_errors() {
        // Temporarily ensure the env var is not set.
        let prev = std::env::var(SECRET_KEY_ENV_VAR).ok();
        std::env::remove_var(SECRET_KEY_ENV_VAR);

        let err = Mpp::new(Config {
            recipient: TEST_RECIPIENT.to_string(),
            secret_key: None,
            ..Default::default()
        })
        .err()
        .expect("should fail");
        assert!(err.to_string().contains("MPP_SECRET_KEY"), "got: {err}");

        // Restore.
        if let Some(v) = prev {
            std::env::set_var(SECRET_KEY_ENV_VAR, v);
        }
    }

    #[test]
    fn new_secret_key_from_env() {
        let prev = std::env::var(SECRET_KEY_ENV_VAR).ok();
        std::env::set_var(SECRET_KEY_ENV_VAR, "env-secret");

        let result = Mpp::new(Config {
            recipient: TEST_RECIPIENT.to_string(),
            secret_key: None,
            ..Default::default()
        });

        // Restore before asserting (so we don't leak state on failure).
        if let Some(v) = prev {
            std::env::set_var(SECRET_KEY_ENV_VAR, v);
        } else {
            std::env::remove_var(SECRET_KEY_ENV_VAR);
        }

        assert!(result.is_ok());
    }

    #[test]
    fn new_valid_config_succeeds() {
        let mpp = test_mpp();
        assert_eq!(mpp.realm(), DEFAULT_REALM);
        assert_eq!(mpp.currency(), "USDC");
        assert_eq!(mpp.recipient(), TEST_RECIPIENT);
        assert_eq!(mpp.decimals(), 6);
    }

    #[test]
    fn new_custom_realm() {
        let mpp = Mpp::new(Config {
            recipient: TEST_RECIPIENT.to_string(),
            secret_key: Some("key".to_string()),
            realm: Some("Custom Realm".to_string()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(mpp.realm(), "Custom Realm");
    }

    #[test]
    fn new_custom_rpc_url() {
        // Should not fail — just verifying it accepts a custom RPC URL.
        let mpp = Mpp::new(Config {
            recipient: TEST_RECIPIENT.to_string(),
            secret_key: Some("key".to_string()),
            rpc_url: Some("http://custom:8899".to_string()),
            ..Default::default()
        });
        assert!(mpp.is_ok());
    }

    #[test]
    fn new_custom_store() {
        let store: Arc<dyn Store> = Arc::new(MemoryStore::new());
        let result = Mpp::new(Config {
            recipient: TEST_RECIPIENT.to_string(),
            secret_key: Some("key".to_string()),
            store: Some(store),
            ..Default::default()
        });
        assert!(result.is_ok());
    }

    // ── default_rpc_url tests ──

    #[test]
    fn default_rpc_url_devnet() {
        assert_eq!(default_rpc_url("devnet"), "https://api.devnet.solana.com");
    }

    #[test]
    fn default_rpc_url_localnet() {
        assert_eq!(default_rpc_url("localnet"), "http://localhost:8899");
    }

    #[test]
    fn default_rpc_url_mainnet() {
        assert_eq!(
            default_rpc_url("mainnet-beta"),
            "https://api.mainnet-beta.solana.com"
        );
    }

    #[test]
    fn default_rpc_url_unknown_defaults_to_mainnet() {
        assert_eq!(
            default_rpc_url("anything"),
            "https://api.mainnet-beta.solana.com"
        );
    }

    // ── charge() and charge_with_options() tests ──

    #[test]
    fn charge_generates_valid_challenge() {
        let mpp = test_mpp();
        let challenge = mpp.charge("0.10").unwrap();

        assert_eq!(challenge.realm, DEFAULT_REALM);
        assert_eq!(challenge.method.as_str(), "solana");
        assert_eq!(challenge.intent.as_str(), "charge");
        assert!(!challenge.id.is_empty());
        assert!(challenge.expires.is_some());

        // Decode the request and verify fields.
        let request: ChargeRequest = challenge.request.decode().unwrap();
        assert_eq!(request.amount, "100000"); // 0.10 * 10^6
        assert_eq!(request.currency, "USDC");
        assert_eq!(request.recipient.as_deref(), Some(TEST_RECIPIENT));
    }

    #[test]
    fn charge_sol_amount_conversion() {
        let mpp = test_mpp_sol();
        let challenge = mpp.charge("1.0").unwrap();

        let request: ChargeRequest = challenge.request.decode().unwrap();
        assert_eq!(request.amount, "1000000000"); // 1 SOL = 10^9 lamports
        assert_eq!(request.currency, "SOL");
    }

    #[test]
    fn charge_integer_amount() {
        let mpp = test_mpp();
        let challenge = mpp.charge("5").unwrap();

        let request: ChargeRequest = challenge.request.decode().unwrap();
        assert_eq!(request.amount, "5000000"); // 5 * 10^6
    }

    #[test]
    fn charge_with_options_description() {
        let mpp = test_mpp();
        let challenge = mpp
            .charge_with_options(
                "1.00",
                ChargeOptions {
                    description: Some("Test payment"),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(challenge.description.as_deref(), Some("Test payment"));
    }

    #[test]
    fn charge_with_options_external_id() {
        let mpp = test_mpp();
        let challenge = mpp
            .charge_with_options(
                "1.00",
                ChargeOptions {
                    external_id: Some("order-123"),
                    ..Default::default()
                },
            )
            .unwrap();

        let request: ChargeRequest = challenge.request.decode().unwrap();
        assert_eq!(request.external_id.as_deref(), Some("order-123"));
    }

    #[test]
    fn charge_with_options_custom_expiry() {
        let mpp = test_mpp();
        let custom_expires = crate::expires::minutes(30);
        let challenge = mpp
            .charge_with_options(
                "1.00",
                ChargeOptions {
                    expires: Some(&custom_expires),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(challenge.expires.as_deref(), Some(custom_expires.as_str()));
    }

    #[test]
    fn charge_invalid_amount_errors() {
        let mpp = test_mpp();
        let result = mpp.charge("not-a-number");
        assert!(result.is_err());
    }

    #[test]
    fn charge_too_many_decimals_errors() {
        let mpp = test_mpp();
        // 6 decimals configured, but providing 7.
        let result = mpp.charge("1.1234567");
        assert!(result.is_err());
    }

    // ── charge_challenge() tests ──

    #[test]
    fn charge_challenge_from_request() {
        let mpp = test_mpp();
        let request = ChargeRequest {
            amount: "500000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };
        let challenge = mpp.charge_challenge(&request).unwrap();

        assert_eq!(challenge.method.as_str(), "solana");
        assert_eq!(challenge.intent.as_str(), "charge");
        assert!(challenge.expires.is_some());

        let decoded: ChargeRequest = challenge.request.decode().unwrap();
        assert_eq!(decoded.amount, "500000");
    }

    #[test]
    fn charge_challenge_with_options() {
        let mpp = test_mpp();
        let request = ChargeRequest {
            amount: "500000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };
        let custom_expires = crate::expires::minutes(10);
        let challenge = mpp
            .charge_challenge_with_options(&request, Some(&custom_expires), Some("Premium access"))
            .unwrap();

        assert_eq!(challenge.expires.as_deref(), Some(custom_expires.as_str()));
        assert_eq!(challenge.description.as_deref(), Some("Premium access"));
    }

    // ── Challenge HMAC verification tests ──

    #[test]
    fn challenge_hmac_verifies_with_correct_secret() {
        let mpp = test_mpp();
        let challenge = mpp.charge("1.00").unwrap();
        assert!(challenge.verify(TEST_SECRET));
    }

    #[test]
    fn challenge_hmac_fails_with_wrong_secret() {
        let mpp = test_mpp();
        let challenge = mpp.charge("1.00").unwrap();
        assert!(!challenge.verify("wrong-secret"));
    }

    #[test]
    fn challenge_hmac_deterministic() {
        // Two challenges with same parameters should have same ID
        // (except for expires timestamp, which varies).
        let mpp = test_mpp();
        let request = ChargeRequest {
            amount: "100000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };
        let expires = "2099-01-01T00:00:00Z";
        let c1 = mpp
            .charge_challenge_with_options(&request, Some(expires), None)
            .unwrap();
        let c2 = mpp
            .charge_challenge_with_options(&request, Some(expires), None)
            .unwrap();
        assert_eq!(c1.id, c2.id);
    }

    #[test]
    fn challenge_hmac_different_amounts_different_ids() {
        let mpp = test_mpp();
        let expires = "2099-01-01T00:00:00Z";

        let r1 = ChargeRequest {
            amount: "100000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };
        let r2 = ChargeRequest {
            amount: "200000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };

        let c1 = mpp
            .charge_challenge_with_options(&r1, Some(expires), None)
            .unwrap();
        let c2 = mpp
            .charge_challenge_with_options(&r2, Some(expires), None)
            .unwrap();
        assert_ne!(c1.id, c2.id);
    }

    // ── verify() — HMAC mismatch, expiry, replay protection ──

    fn build_credential(
        mpp: &Mpp,
        request: &ChargeRequest,
        payload: serde_json::Value,
    ) -> PaymentCredential {
        let challenge = mpp.charge_challenge(request).unwrap();
        PaymentCredential {
            challenge: challenge.to_echo(),
            source: None,
            payload,
        }
    }

    fn build_credential_with_expires(
        mpp: &Mpp,
        request: &ChargeRequest,
        expires: &str,
        payload: serde_json::Value,
    ) -> PaymentCredential {
        let challenge = mpp
            .charge_challenge_with_options(request, Some(expires), None)
            .unwrap();
        PaymentCredential {
            challenge: challenge.to_echo(),
            source: None,
            payload,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_rejects_tampered_challenge_id() {
        let mpp = test_mpp();
        let request = ChargeRequest {
            amount: "100000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };
        let payload = serde_json::json!({"type": "signature", "signature": "fakesig"});
        let mut cred = build_credential(&mpp, &request, payload);
        cred.challenge.id = "tampered-id".to_string();

        let err = mpp.verify(&cred, &request).await.unwrap_err();
        assert_eq!(err.code, Some("malformed-credential"));
        assert!(err.message.contains("Challenge ID mismatch"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_rejects_expired_challenge() {
        let mpp = test_mpp();
        let request = ChargeRequest {
            amount: "100000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };
        // Use an already-expired timestamp.
        let expired = "2020-01-01T00:00:00Z";
        let payload = serde_json::json!({"type": "signature", "signature": "fakesig"});
        let cred = build_credential_with_expires(&mpp, &request, expired, payload);

        let err = mpp.verify(&cred, &request).await.unwrap_err();
        assert_eq!(err.code, Some("payment-expired"));
        assert!(err.message.contains("expired"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_rejects_invalid_expires_format() {
        let mpp = test_mpp();
        let request = ChargeRequest {
            amount: "100000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };
        let payload = serde_json::json!({"type": "signature", "signature": "fakesig"});
        let mut cred = build_credential(&mpp, &request, payload);
        // Manually set an invalid expires but recompute the HMAC to match.
        let bad_expires = "not-a-date";
        let new_id = compute_challenge_id(
            TEST_SECRET,
            &mpp.realm,
            cred.challenge.method.as_str(),
            cred.challenge.intent.as_str(),
            cred.challenge.request.raw(),
            Some(bad_expires),
            None,
            None,
        );
        cred.challenge.expires = Some(bad_expires.to_string());
        cred.challenge.id = new_id;

        let err = mpp.verify(&cred, &request).await.unwrap_err();
        assert!(err.message.contains("Invalid expires timestamp"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_rejects_invalid_payload() {
        let mpp = test_mpp();
        let request = ChargeRequest {
            amount: "100000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };
        // Payload missing the "type" tag needed for CredentialPayload deserialization.
        let bad_payload = serde_json::json!({"foo": "bar"});
        let cred =
            build_credential_with_expires(&mpp, &request, "2099-01-01T00:00:00Z", bad_payload);

        let err = mpp.verify(&cred, &request).await.unwrap_err();
        assert_eq!(err.code, Some("malformed-credential"));
        assert!(err.message.contains("Invalid credential payload"));
    }

    // ── verify_credential() tests ──

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_credential_rejects_tampered_id() {
        let mpp = test_mpp();
        let challenge = mpp.charge("0.10").unwrap();
        let mut cred = PaymentCredential {
            challenge: challenge.to_echo(),
            source: None,
            payload: serde_json::json!({"type": "signature", "signature": "x"}),
        };
        cred.challenge.id = "bad".to_string();

        let err = mpp.verify_credential(&cred).await.unwrap_err();
        assert_eq!(err.code, Some("malformed-credential"));
    }

    // ── verify_credential_with_expected() tests ──

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_credential_with_expected_amount_mismatch() {
        let mpp = test_mpp();
        let challenge = mpp.charge("0.10").unwrap();
        let cred = PaymentCredential {
            challenge: challenge.to_echo(),
            source: None,
            payload: serde_json::json!({"type": "signature", "signature": "x"}),
        };

        let expected = ChargeRequest {
            amount: "999999".to_string(), // different from 100000
            currency: "USDC".to_string(),
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };

        let err = mpp
            .verify_credential_with_expected(&cred, &expected)
            .await
            .unwrap_err();
        assert_eq!(err.code, Some("malformed-credential"));
        assert!(err.message.contains("Amount mismatch"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_credential_with_expected_currency_mismatch() {
        let mpp = test_mpp();
        let challenge = mpp.charge("0.10").unwrap();
        let cred = PaymentCredential {
            challenge: challenge.to_echo(),
            source: None,
            payload: serde_json::json!({"type": "signature", "signature": "x"}),
        };

        let expected = ChargeRequest {
            amount: "100000".to_string(),
            currency: "SOL".to_string(), // mismatch: challenge has USDC
            recipient: Some(TEST_RECIPIENT.to_string()),
            ..Default::default()
        };

        let err = mpp
            .verify_credential_with_expected(&cred, &expected)
            .await
            .unwrap_err();
        assert_eq!(err.code, Some("malformed-credential"));
        assert!(err.message.contains("Currency mismatch"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn verify_credential_with_expected_recipient_mismatch() {
        let mpp = test_mpp();
        let challenge = mpp.charge("0.10").unwrap();
        let cred = PaymentCredential {
            challenge: challenge.to_echo(),
            source: None,
            payload: serde_json::json!({"type": "signature", "signature": "x"}),
        };

        let expected = ChargeRequest {
            amount: "100000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some(Pubkey::new_unique().to_string()), // different recipient
            ..Default::default()
        };

        let err = mpp
            .verify_credential_with_expected(&cred, &expected)
            .await
            .unwrap_err();
        assert_eq!(err.code, Some("malformed-credential"));
        assert!(err.message.contains("Recipient mismatch"));
    }

    // ── Replay protection tests ──

    #[tokio::test(flavor = "multi_thread")]
    async fn replay_protection_marks_and_detects_consumed() {
        let store = Arc::new(MemoryStore::new());
        let mpp = Mpp::new(Config {
            recipient: TEST_RECIPIENT.to_string(),
            secret_key: Some(TEST_SECRET.to_string()),
            store: Some(store.clone()),
            network: "devnet".to_string(),
            ..Default::default()
        })
        .unwrap();

        let key = "solana-charge:consumed:testsig123";
        // Not consumed yet.
        assert!(store.get(key).await.unwrap().is_none());

        // Mark as consumed.
        store.put(key, serde_json::json!(true)).await.unwrap();

        // Now it should be detected.
        assert!(store.get(key).await.unwrap().is_some());
    }

    // ── Receipt tests ──

    #[test]
    fn receipt_success_format() {
        let receipt = Receipt::success("solana", "5UfDuX123", "challenge-id-abc");
        assert!(receipt.is_success());
        assert_eq!(receipt.method.as_str(), "solana");
        assert_eq!(receipt.reference, "5UfDuX123");
        assert_eq!(receipt.challenge_id, "challenge-id-abc");
        assert!(!receipt.timestamp.is_empty());
        // Timestamp should be RFC 3339.
        assert!(receipt.timestamp.contains('T'));
    }

    #[test]
    fn receipt_serializes_correctly() {
        let receipt = Receipt::success("solana", "sig-abc", "cid-123");
        let json = serde_json::to_value(&receipt).unwrap();
        assert_eq!(json["status"], "success");
        assert_eq!(json["method"], "solana");
        assert_eq!(json["reference"], "sig-abc");
        assert_eq!(json["challengeId"], "cid-123");
    }

    // ── VerificationError tests ──

    #[test]
    fn verification_error_new_has_no_code() {
        let err = VerificationError::new("Something went wrong");
        assert_eq!(err.message, "Something went wrong");
        assert!(err.code.is_none());
        assert!(!err.retryable);
    }

    #[test]
    fn verification_error_expired() {
        let err = VerificationError::expired("expired at X");
        assert_eq!(err.code, Some("payment-expired"));
        assert!(!err.retryable);
    }

    #[test]
    fn verification_error_invalid_amount() {
        let err = VerificationError::invalid_amount("bad amount");
        assert_eq!(err.code, Some("verification-failed"));
        assert!(!err.retryable);
    }

    #[test]
    fn verification_error_invalid_recipient() {
        let err = VerificationError::invalid_recipient("wrong recipient");
        assert_eq!(err.code, Some("verification-failed"));
    }

    #[test]
    fn verification_error_transaction_failed() {
        let err = VerificationError::transaction_failed("tx failed");
        assert_eq!(err.code, Some("verification-failed"));
    }

    #[test]
    fn verification_error_not_found() {
        let err = VerificationError::not_found("tx not found");
        assert_eq!(err.code, Some("verification-failed"));
    }

    #[test]
    fn verification_error_network_error_is_retryable() {
        let err = VerificationError::network_error("timeout");
        assert_eq!(err.code, Some("verification-failed"));
        assert!(err.retryable);
    }

    #[test]
    fn verification_error_credential_mismatch() {
        let err = VerificationError::credential_mismatch("id mismatch");
        assert_eq!(err.code, Some("malformed-credential"));
    }

    #[test]
    fn verification_error_invalid_payload() {
        let err = VerificationError::invalid_payload("bad payload");
        assert_eq!(err.code, Some("malformed-credential"));
    }

    #[test]
    fn verification_error_signature_consumed() {
        let err = VerificationError::signature_consumed("already used");
        assert_eq!(err.code, Some("signature-consumed"));
    }

    #[test]
    fn verification_error_display_with_code() {
        let err = VerificationError::expired("at time X");
        assert_eq!(format!("{err}"), "[payment-expired] at time X");
    }

    #[test]
    fn verification_error_display_without_code() {
        let err = VerificationError::new("generic");
        assert_eq!(format!("{err}"), "generic");
    }

    #[test]
    fn verification_error_is_std_error() {
        let err = VerificationError::new("test");
        let _: &dyn std::error::Error = &err;
    }

    // ── On-chain parsed-instruction helpers (find_sol_transfer, find_spl_transfer) ──

    #[test]
    fn find_sol_transfer_success() {
        let instructions = vec![serde_json::json!({
            "parsed": {
                "type": "transfer",
                "info": {
                    "destination": "RecipientPubkey",
                    "lamports": 1000000
                }
            }
        })];
        assert!(find_sol_transfer(&instructions, "RecipientPubkey", 1_000_000).is_ok());
    }

    #[test]
    fn find_sol_transfer_wrong_amount() {
        let instructions = vec![serde_json::json!({
            "parsed": {
                "type": "transfer",
                "info": {
                    "destination": "RecipientPubkey",
                    "lamports": 500000
                }
            }
        })];
        assert!(find_sol_transfer(&instructions, "RecipientPubkey", 1_000_000).is_err());
    }

    #[test]
    fn find_sol_transfer_wrong_recipient() {
        let instructions = vec![serde_json::json!({
            "parsed": {
                "type": "transfer",
                "info": {
                    "destination": "WrongPubkey",
                    "lamports": 1000000
                }
            }
        })];
        assert!(find_sol_transfer(&instructions, "RecipientPubkey", 1_000_000).is_err());
    }

    #[test]
    fn find_sol_transfer_empty_instructions() {
        assert!(find_sol_transfer(&[], "RecipientPubkey", 1_000_000).is_err());
    }

    #[test]
    fn find_sol_transfer_ignores_non_transfer_types() {
        let instructions = vec![serde_json::json!({
            "parsed": {
                "type": "createAccount",
                "info": {
                    "destination": "RecipientPubkey",
                    "lamports": 1000000
                }
            }
        })];
        assert!(find_sol_transfer(&instructions, "RecipientPubkey", 1_000_000).is_err());
    }

    #[test]
    fn verify_sol_transfers_with_splits() {
        let primary_recipient = "PrimaryRecipient";
        let split_recipient = "SplitRecipient";
        let instructions = vec![
            serde_json::json!({
                "parsed": {
                    "type": "transfer",
                    "info": {
                        "destination": primary_recipient,
                        "lamports": 800000
                    }
                }
            }),
            serde_json::json!({
                "parsed": {
                    "type": "transfer",
                    "info": {
                        "destination": split_recipient,
                        "lamports": 200000
                    }
                }
            }),
        ];

        let splits = vec![Split {
            recipient: split_recipient.to_string(),
            amount: "200000".to_string(),
            memo: None,
        }];

        assert!(verify_sol_transfers(&instructions, primary_recipient, 800000, &splits).is_ok());
    }

    #[test]
    fn verify_sol_transfers_missing_split() {
        let instructions = vec![serde_json::json!({
            "parsed": {
                "type": "transfer",
                "info": {
                    "destination": "PrimaryRecipient",
                    "lamports": 800000
                }
            }
        })];

        let splits = vec![Split {
            recipient: "SplitRecipient".to_string(),
            amount: "200000".to_string(),
            memo: None,
        }];

        let err =
            verify_sol_transfers(&instructions, "PrimaryRecipient", 800000, &splits).unwrap_err();
        assert!(err.message.contains("Missing split transfer"));
    }

    // ── find_spl_transfer tests ──

    #[test]
    fn find_spl_transfer_success() {
        let owner = "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY";
        let mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        let tp = programs::TOKEN_PROGRAM;

        // Derive expected ATA.
        let owner_pk = Pubkey::from_str(owner).unwrap();
        let mint_pk = Pubkey::from_str(mint).unwrap();
        let tp_pk = Pubkey::from_str(tp).unwrap();
        let ata_program = Pubkey::from_str(programs::ASSOCIATED_TOKEN_PROGRAM).unwrap();
        let (dest_ata, _) = Pubkey::find_program_address(
            &[owner_pk.as_ref(), tp_pk.as_ref(), mint_pk.as_ref()],
            &ata_program,
        );

        let instructions = vec![serde_json::json!({
            "programId": tp,
            "parsed": {
                "type": "transferChecked",
                "info": {
                    "destination": dest_ata.to_string(),
                    "mint": mint,
                    "tokenAmount": {
                        "amount": "1000000"
                    }
                }
            }
        })];

        assert!(find_spl_transfer(&instructions, owner, 1_000_000).is_ok());
    }

    #[test]
    fn find_spl_transfer_wrong_program() {
        let instructions = vec![serde_json::json!({
            "programId": "WrongProgram111111111111111111111111111111",
            "parsed": {
                "type": "transferChecked",
                "info": {
                    "destination": "SomeAta",
                    "mint": "SomeMint",
                    "tokenAmount": {
                        "amount": "1000000"
                    }
                }
            }
        })];
        assert!(find_spl_transfer(&instructions, "SomeOwner", 1_000_000).is_err());
    }

    #[test]
    fn find_spl_transfer_wrong_type() {
        let instructions = vec![serde_json::json!({
            "programId": programs::TOKEN_PROGRAM,
            "parsed": {
                "type": "transfer",
                "info": {
                    "destination": "SomeAta",
                    "mint": "SomeMint",
                    "tokenAmount": {
                        "amount": "1000000"
                    }
                }
            }
        })];
        assert!(find_spl_transfer(&instructions, "SomeOwner", 1_000_000).is_err());
    }

    // ── verify_ata_owner edge cases ──

    #[test]
    fn verify_ata_owner_invalid_owner_returns_false() {
        assert!(!verify_ata_owner(
            "abc",
            "invalid!!!",
            "mint",
            programs::TOKEN_PROGRAM
        ));
    }

    #[test]
    fn verify_ata_owner_invalid_mint_returns_false() {
        assert!(!verify_ata_owner(
            "abc",
            "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
            "invalid!!!",
            programs::TOKEN_PROGRAM
        ));
    }

    #[test]
    fn verify_ata_owner_invalid_token_program_returns_false() {
        assert!(!verify_ata_owner(
            "abc",
            "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            "invalid!!!"
        ));
    }

    // ── Pre-broadcast: splits tests ──

    #[test]
    fn sol_transfer_with_splits_passes() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let split_recipient = Pubkey::new_unique();
        let primary_amount = 800_000u64;
        let split_amount = 200_000u64;
        let total = primary_amount + split_amount;

        let tx = dummy_tx(
            vec![
                system_transfer_ix(&sender, &recipient, primary_amount),
                system_transfer_ix(&sender, &split_recipient, split_amount),
            ],
            &sender,
        );
        let request = charge_request(total, "SOL", &recipient);
        let method_details = MethodDetails {
            splits: Some(vec![Split {
                recipient: split_recipient.to_string(),
                amount: split_amount.to_string(),
                memo: None,
            }]),
            ..Default::default()
        };

        assert!(verify_transaction_pre_broadcast(&tx, &request, &method_details).is_ok());
    }

    #[test]
    fn splits_exceeding_total_rejected() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let split_recipient = Pubkey::new_unique();

        let tx = dummy_tx(vec![], &sender);
        let request = charge_request(100, "SOL", &recipient);
        let method_details = MethodDetails {
            splits: Some(vec![Split {
                recipient: split_recipient.to_string(),
                amount: "200".to_string(), // exceeds total of 100
                memo: None,
            }]),
            ..Default::default()
        };

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(err.message.contains("Split amounts exceed total amount"));
    }

    #[test]
    fn splits_consuming_entire_amount_rejected() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let split_recipient = Pubkey::new_unique();

        let tx = dummy_tx(vec![], &sender);
        let request = charge_request(1000, "SOL", &recipient);
        let method_details = MethodDetails {
            splits: Some(vec![Split {
                recipient: split_recipient.to_string(),
                amount: "1000".to_string(), // exactly equals total => primary = 0
                memo: None,
            }]),
            ..Default::default()
        };

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(err.message.contains("Primary amount is zero"));
    }

    #[test]
    fn invalid_amount_string_rejected() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();

        let tx = dummy_tx(vec![], &sender);
        let request = ChargeRequest {
            amount: "not-a-number".to_string(),
            currency: "SOL".to_string(),
            recipient: Some(recipient.to_string()),
            ..Default::default()
        };
        let method_details = MethodDetails::default();

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(err.message.contains("Invalid amount"));
    }

    #[test]
    fn invalid_recipient_pubkey_in_request_rejected() {
        let sender = Pubkey::new_unique();
        let tx = dummy_tx(
            vec![system_transfer_ix(&sender, &Pubkey::new_unique(), 1000)],
            &sender,
        );
        let request = ChargeRequest {
            amount: "1000".to_string(),
            currency: "SOL".to_string(),
            recipient: Some("not-a-valid-pubkey!!!".to_string()),
            ..Default::default()
        };
        let method_details = MethodDetails::default();

        let err = verify_transaction_pre_broadcast(&tx, &request, &method_details).unwrap_err();
        assert!(err.message.contains("Invalid recipient"));
    }

    // ── SPL with splits pre-broadcast ──

    #[test]
    fn spl_transfer_with_splits_passes() {
        let sender = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let split_recipient = Pubkey::new_unique();
        let mint = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();
        let primary_amount = 800_000u64;
        let split_amount = 200_000u64;
        let total = primary_amount + split_amount;

        let tp = token_program_id();
        let source_ata = derive_ata(&sender, &mint, &tp);
        let dest_ata = derive_ata(&recipient, &mint, &tp);
        let split_dest_ata = derive_ata(&split_recipient, &mint, &tp);

        let tx = dummy_tx(
            vec![
                spl_transfer_checked_ix(&source_ata, &mint, &dest_ata, &sender, primary_amount, 6),
                spl_transfer_checked_ix(
                    &source_ata,
                    &mint,
                    &split_dest_ata,
                    &sender,
                    split_amount,
                    6,
                ),
            ],
            &sender,
        );
        let request = charge_request(total, "USDC", &recipient);
        let method_details = MethodDetails {
            splits: Some(vec![Split {
                recipient: split_recipient.to_string(),
                amount: split_amount.to_string(),
                memo: None,
            }]),
            ..Default::default()
        };

        assert!(verify_transaction_pre_broadcast(&tx, &request, &method_details).is_ok());
    }

    // ── ChargeOptions fee_payer flag in method details ──

    #[test]
    fn charge_with_fee_payer_includes_method_details() {
        let mpp = Mpp::new(Config {
            recipient: TEST_RECIPIENT.to_string(),
            secret_key: Some(TEST_SECRET.to_string()),
            fee_payer: true,
            network: "devnet".to_string(),
            ..Default::default()
        })
        .unwrap();
        let challenge = mpp.charge("1.00").unwrap();
        let request: ChargeRequest = challenge.request.decode().unwrap();

        let details: MethodDetails =
            serde_json::from_value(request.method_details.unwrap()).unwrap();
        assert_eq!(details.fee_payer, Some(true));
    }

    #[test]
    fn charge_options_fee_payer_flag() {
        let mpp = test_mpp();
        let challenge = mpp
            .charge_with_options(
                "1.00",
                ChargeOptions {
                    fee_payer: true,
                    ..Default::default()
                },
            )
            .unwrap();
        let request: ChargeRequest = challenge.request.decode().unwrap();
        let details: MethodDetails =
            serde_json::from_value(request.method_details.unwrap()).unwrap();
        assert_eq!(details.fee_payer, Some(true));
    }

    // ── Method details include network and decimals ──

    #[test]
    fn charge_method_details_contain_network_and_decimals() {
        let mpp = test_mpp();
        let challenge = mpp.charge("1.00").unwrap();
        let request: ChargeRequest = challenge.request.decode().unwrap();
        let details = request.method_details.unwrap();
        assert_eq!(details["network"], "devnet");
        assert_eq!(details["decimals"], 6);
    }
}
