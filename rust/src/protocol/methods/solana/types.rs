use serde::{Deserialize, Serialize};

/// Method name for Solana payments.
pub const METHOD_NAME: &str = "solana";

/// Intent name for one-time charges.
pub const INTENT_CHARGE: &str = "charge";

/// Default RPC URLs per network.
pub fn default_rpc_url(network: &str) -> &'static str {
    match network {
        "devnet" => "https://api.devnet.solana.com",
        "localnet" => "http://localhost:8899",
        _ => "https://api.mainnet-beta.solana.com",
    }
}

/// Well-known program addresses.
pub mod programs {
    pub const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    pub const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    pub const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    pub const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
    pub const MEMO_PROGRAM: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
}

/// Solana-specific method details in the challenge request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolanaMethodDetails {
    /// Unique reference ID for this charge.
    pub reference: String,

    /// Solana network: mainnet-beta, devnet, or localnet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,

    /// Token decimals (required when currency is a mint address).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u8>,

    /// Token program address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_program: Option<String>,

    /// If true, server pays transaction fees.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_payer: Option<bool>,

    /// Server's fee payer public key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_payer_key: Option<String>,

    /// Additional payment splits (max 8).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub splits: Option<Vec<Split>>,

    /// Server-provided recent blockhash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recent_blockhash: Option<String>,
}

/// A payment split — additional transfer in the same asset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Split {
    /// Base58-encoded recipient public key.
    pub recipient: String,
    /// Amount in base units.
    pub amount: String,
    /// Optional memo (max 566 bytes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

/// Credential payload types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CredentialPayload {
    /// Pull mode: client sends signed transaction bytes.
    #[serde(rename = "transaction")]
    Transaction {
        /// Base64-encoded serialized signed transaction.
        transaction: String,
    },
    /// Push mode: client sends confirmed signature.
    #[serde(rename = "signature")]
    Signature {
        /// Base58-encoded transaction signature.
        signature: String,
    },
}

/// Server-side charge configuration.
#[derive(Debug, Clone)]
pub struct SolanaChargeConfig {
    /// Base58-encoded recipient public key.
    pub recipient: String,
    /// Solana network.
    pub network: String,
    /// RPC URL (overrides default for the network).
    pub rpc_url: Option<String>,
    /// Currency: "sol" for native, or a mint address for SPL tokens.
    pub currency: String,
    /// Token decimals.
    pub decimals: Option<u8>,
    /// Token program address.
    pub token_program: Option<String>,
    /// Payment splits.
    pub splits: Option<Vec<Split>>,
}

impl SolanaChargeConfig {
    /// Get the effective RPC URL.
    pub fn rpc_url(&self) -> String {
        self.rpc_url
            .clone()
            .unwrap_or_else(|| default_rpc_url(&self.network).to_string())
    }

    /// Get the effective token program.
    pub fn token_program(&self) -> &str {
        self.token_program
            .as_deref()
            .unwrap_or(programs::TOKEN_PROGRAM)
    }
}
