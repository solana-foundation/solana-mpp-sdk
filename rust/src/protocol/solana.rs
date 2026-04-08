//! Solana-specific types for the charge intent.

use serde::{Deserialize, Serialize};

/// Well-known program addresses.
pub mod programs {
    pub const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    pub const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    pub const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    pub const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
}

/// Default RPC URLs per network.
pub fn default_rpc_url(network: &str) -> &'static str {
    match network {
        "devnet" => "https://api.devnet.solana.com",
        "localnet" => "http://localhost:8899",
        _ => "https://api.mainnet-beta.solana.com",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            default_rpc_url("mainnet"),
            "https://api.mainnet-beta.solana.com"
        );
    }

    #[test]
    fn default_rpc_url_unknown_defaults_to_mainnet() {
        assert_eq!(
            default_rpc_url("testnet"),
            "https://api.mainnet-beta.solana.com"
        );
        assert_eq!(default_rpc_url(""), "https://api.mainnet-beta.solana.com");
        assert_eq!(
            default_rpc_url("anything"),
            "https://api.mainnet-beta.solana.com"
        );
    }

    // ── programs module constants ──

    #[test]
    fn program_constants_are_valid_pubkeys() {
        use solana_pubkey::Pubkey;
        use std::str::FromStr;

        assert!(Pubkey::from_str(programs::TOKEN_PROGRAM).is_ok());
        assert!(Pubkey::from_str(programs::TOKEN_2022_PROGRAM).is_ok());
        assert!(Pubkey::from_str(programs::ASSOCIATED_TOKEN_PROGRAM).is_ok());
        assert!(Pubkey::from_str(programs::SYSTEM_PROGRAM).is_ok());
    }

    #[test]
    fn program_constants_are_distinct() {
        let all = [
            programs::TOKEN_PROGRAM,
            programs::TOKEN_2022_PROGRAM,
            programs::ASSOCIATED_TOKEN_PROGRAM,
            programs::SYSTEM_PROGRAM,
        ];
        for (i, a) in all.iter().enumerate() {
            for (j, b) in all.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b, "Programs at index {i} and {j} should differ");
                }
            }
        }
    }

    // ── MethodDetails serde ──

    #[test]
    fn method_details_default() {
        let md = MethodDetails::default();
        assert!(md.network.is_none());
        assert!(md.decimals.is_none());
        assert!(md.token_program.is_none());
        assert!(md.fee_payer.is_none());
        assert!(md.fee_payer_key.is_none());
        assert!(md.splits.is_none());
        assert!(md.recent_blockhash.is_none());
    }

    #[test]
    fn method_details_serialization_roundtrip() {
        let md = MethodDetails {
            network: Some("devnet".to_string()),
            decimals: Some(6),
            token_program: Some(programs::TOKEN_PROGRAM.to_string()),
            fee_payer: Some(true),
            fee_payer_key: Some("SomeKey123".to_string()),
            splits: Some(vec![Split {
                recipient: "Recipient1".to_string(),
                amount: "100".to_string(),
                label: None,
                memo: Some("test memo".to_string()),
            }]),
            recent_blockhash: Some("BlockhashXyz".to_string()),
        };
        let json = serde_json::to_string(&md).unwrap();
        let deserialized: MethodDetails = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.network.as_deref(), Some("devnet"));
        assert_eq!(deserialized.decimals, Some(6));
        assert_eq!(deserialized.fee_payer, Some(true));
        assert_eq!(deserialized.splits.as_ref().unwrap().len(), 1);
        assert_eq!(
            deserialized.splits.as_ref().unwrap()[0].memo.as_deref(),
            Some("test memo")
        );
    }

    #[test]
    fn method_details_omits_none_fields() {
        let md = MethodDetails::default();
        let json = serde_json::to_string(&md).unwrap();
        assert_eq!(json, "{}");
    }

    // ── CredentialPayload serde ──

    #[test]
    fn credential_payload_transaction_serde() {
        let cp = CredentialPayload::Transaction {
            transaction: "base64data".to_string(),
        };
        let json = serde_json::to_string(&cp).unwrap();
        assert!(json.contains("\"type\":\"transaction\""));
        assert!(json.contains("\"transaction\":\"base64data\""));
        let deserialized: CredentialPayload = serde_json::from_str(&json).unwrap();
        match deserialized {
            CredentialPayload::Transaction { transaction } => {
                assert_eq!(transaction, "base64data");
            }
            _ => panic!("Expected Transaction variant"),
        }
    }

    #[test]
    fn credential_payload_signature_serde() {
        let cp = CredentialPayload::Signature {
            signature: "sig123".to_string(),
        };
        let json = serde_json::to_string(&cp).unwrap();
        assert!(json.contains("\"type\":\"signature\""));
        assert!(json.contains("\"signature\":\"sig123\""));
        let deserialized: CredentialPayload = serde_json::from_str(&json).unwrap();
        match deserialized {
            CredentialPayload::Signature { signature } => {
                assert_eq!(signature, "sig123");
            }
            _ => panic!("Expected Signature variant"),
        }
    }

    // ── Split serde ──

    #[test]
    fn split_serde_with_memo() {
        let split = Split {
            recipient: "R1".to_string(),
            amount: "500".to_string(),
            label: None,
            memo: Some("tip".to_string()),
        };
        let json = serde_json::to_string(&split).unwrap();
        assert!(json.contains("\"memo\":\"tip\""));
        let deserialized: Split = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.memo.as_deref(), Some("tip"));
    }

    #[test]
    fn split_serde_without_memo() {
        let split = Split {
            recipient: "R1".to_string(),
            amount: "500".to_string(),
            label: None,
            memo: None,
        };
        let json = serde_json::to_string(&split).unwrap();
        assert!(!json.contains("memo"));
    }
}

/// Solana-specific method details in the challenge request.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u8>,

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
    /// Human-readable label for the recipient (e.g. "Vendor", "Tax Authority").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Optional memo (max 566 bytes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

/// Credential payload — what the client sends in the Authorization header.
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
