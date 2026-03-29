//! Charge intent request type.
//!
//! The charge intent represents a one-time payment request. All fields are
//! strings to remain method-agnostic.

use serde::{Deserialize, Serialize};

use crate::error::Error;

/// Charge request (for charge intent).
///
/// All fields are strings to remain method-agnostic. Use the methods layer
/// for typed accessors (e.g., Solana-specific `SolanaMethodDetails`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChargeRequest {
    /// Amount in base units (e.g., lamports, micro-USDC).
    pub amount: String,

    /// Currency/asset identifier (e.g., "sol", mint address, "USDC").
    pub currency: String,

    /// Token decimals for amount conversion.
    #[serde(skip)]
    pub decimals: Option<u8>,

    /// Recipient address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,

    /// Human-readable description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Merchant reference ID.
    #[serde(rename = "externalId", skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,

    /// Method-specific extension fields.
    #[serde(rename = "methodDetails", skip_serializing_if = "Option::is_none")]
    pub method_details: Option<serde_json::Value>,
}

impl ChargeRequest {
    /// Apply the decimals transform, converting human-readable amount to base units.
    pub fn with_base_units(mut self) -> Result<Self, Error> {
        if let Some(decimals) = self.decimals {
            self.amount = super::parse_units(&self.amount, decimals)?;
            self.decimals = None;
        }
        Ok(self)
    }

    /// Parse the amount as u64.
    pub fn parse_amount(&self) -> Result<u64, Error> {
        self.amount
            .parse()
            .map_err(|_| Error::Other(format!("Invalid amount: {}", self.amount)))
    }

    /// Validate that the charge amount does not exceed a maximum.
    pub fn validate_max_amount(&self, max_amount: &str) -> Result<(), Error> {
        let amount = self.parse_amount()?;
        let max: u64 = max_amount
            .parse()
            .map_err(|_| Error::Other(format!("Invalid max amount: {max_amount}")))?;
        if amount > max {
            return Err(Error::Other(format!(
                "Amount {amount} exceeds maximum {max}"
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charge_request_serialization() {
        let req = ChargeRequest {
            amount: "10000".to_string(),
            currency: "USDC".to_string(),
            recipient: Some("CXhrFZ...".to_string()),
            method_details: Some(serde_json::json!({
                "network": "devnet",
                "decimals": 6
            })),
            ..Default::default()
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"amount\":\"10000\""));
        assert!(json.contains("\"methodDetails\""));
    }

    #[test]
    fn parse_amount() {
        let req = ChargeRequest {
            amount: "1000000".to_string(),
            ..Default::default()
        };
        assert_eq!(req.parse_amount().unwrap(), 1_000_000u64);
    }

    #[test]
    fn with_base_units() {
        let req = ChargeRequest {
            amount: "1.5".to_string(),
            decimals: Some(6),
            ..Default::default()
        };
        let converted = req.with_base_units().unwrap();
        assert_eq!(converted.amount, "1500000");
    }
}
