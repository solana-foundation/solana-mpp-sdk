//! Core challenge, credential, and receipt types.

use serde::{Deserialize, Serialize};

use super::types::{Base64UrlJson, IntentName, MethodName, ReceiptStatus};

/// Payment challenge from server (parsed from WWW-Authenticate header).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentChallenge {
    pub id: String,
    pub realm: String,
    pub method: MethodName,
    pub intent: IntentName,
    /// Method+intent specific request data (base64url-encoded JSON).
    pub request: Base64UrlJson,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opaque: Option<Base64UrlJson>,
}

impl PaymentChallenge {
    /// Create a new payment challenge with an explicit ID.
    pub fn new(
        id: impl Into<String>,
        realm: impl Into<String>,
        method: impl Into<MethodName>,
        intent: impl Into<IntentName>,
        request: Base64UrlJson,
    ) -> Self {
        Self {
            id: id.into(),
            realm: realm.into(),
            method: method.into(),
            intent: intent.into(),
            request,
            expires: None,
            description: None,
            digest: None,
            opaque: None,
        }
    }

    /// Create a new payment challenge with an HMAC-bound ID.
    ///
    /// Enables stateless verification without storing challenge state.
    pub fn with_secret_key(
        secret_key: &str,
        realm: impl Into<String>,
        method: impl Into<MethodName>,
        intent: impl Into<IntentName>,
        request: Base64UrlJson,
    ) -> Self {
        let realm = realm.into();
        let method = method.into();
        let intent = intent.into();
        let id = compute_challenge_id(
            secret_key,
            &realm,
            method.as_str(),
            intent.as_str(),
            request.raw(),
            None,
            None,
            None,
        );
        Self {
            id,
            realm,
            method,
            intent,
            request,
            expires: None,
            description: None,
            digest: None,
            opaque: None,
        }
    }

    /// Create with HMAC-bound ID including all optional fields.
    #[allow(clippy::too_many_arguments)]
    pub fn with_secret_key_full(
        secret_key: &str,
        realm: impl Into<String>,
        method: impl Into<MethodName>,
        intent: impl Into<IntentName>,
        request: Base64UrlJson,
        expires: Option<&str>,
        digest: Option<&str>,
        description: Option<&str>,
        opaque: Option<Base64UrlJson>,
    ) -> Self {
        let realm = realm.into();
        let method = method.into();
        let intent = intent.into();
        let id = compute_challenge_id(
            secret_key,
            &realm,
            method.as_str(),
            intent.as_str(),
            request.raw(),
            expires,
            digest,
            opaque.as_ref().map(|o| o.raw()),
        );
        Self {
            id,
            realm,
            method,
            intent,
            request,
            expires: expires.map(String::from),
            description: description.map(String::from),
            digest: digest.map(String::from),
            opaque,
        }
    }

    pub fn with_expires(mut self, expires: impl Into<String>) -> Self {
        self.expires = Some(expires.into());
        self
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Create a challenge echo for use in credentials.
    pub fn to_echo(&self) -> ChallengeEcho {
        ChallengeEcho {
            id: self.id.clone(),
            realm: self.realm.clone(),
            method: self.method.clone(),
            intent: self.intent.clone(),
            request: self.request.clone(),
            expires: self.expires.clone(),
            digest: self.digest.clone(),
            opaque: self.opaque.clone(),
        }
    }

    /// Format as WWW-Authenticate header value.
    pub fn to_header(&self) -> Result<String, crate::error::Error> {
        super::format_www_authenticate(self)
    }

    /// Parse from a WWW-Authenticate header value.
    pub fn from_header(header: &str) -> Result<Self, crate::error::Error> {
        super::parse_www_authenticate(header)
    }

    /// Verify that this challenge's ID matches the expected HMAC.
    pub fn verify(&self, secret_key: &str) -> bool {
        let expected_id = compute_challenge_id(
            secret_key,
            &self.realm,
            self.method.as_str(),
            self.intent.as_str(),
            self.request.raw(),
            self.expires.as_deref(),
            self.digest.as_deref(),
            self.opaque.as_ref().map(|o| o.raw()),
        );
        constant_time_eq(&self.id, &expected_id)
    }

    /// Returns true if the challenge has expired.
    pub fn is_expired(&self) -> bool {
        match &self.expires {
            None => false,
            Some(s) => {
                match time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
                {
                    Ok(expires) => expires <= time::OffsetDateTime::now_utc(),
                    Err(_) => true, // fail-closed
                }
            }
        }
    }
}

/// Compute an HMAC-SHA256 challenge ID from challenge parameters.
///
/// Concatenates `realm|method|intent|request|expires|digest|opaque` and
/// computes HMAC-SHA256 with the secret key, then base64url-encodes.
#[allow(clippy::too_many_arguments)]
pub fn compute_challenge_id(
    secret_key: &str,
    realm: &str,
    method: &str,
    intent: &str,
    request: &str,
    expires: Option<&str>,
    digest: Option<&str>,
    opaque: Option<&str>,
) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    type HmacSha256 = Hmac<Sha256>;

    let hmac_input = [
        realm,
        method,
        intent,
        request,
        expires.unwrap_or(""),
        digest.unwrap_or(""),
        opaque.unwrap_or(""),
    ]
    .join("|");

    let mut mac =
        HmacSha256::new_from_slice(secret_key.as_bytes()).expect("HMAC can take key of any size");
    mac.update(hmac_input.as_bytes());
    let result = mac.finalize();

    super::base64url_encode(&result.into_bytes())
}

/// Constant-time string comparison to prevent timing attacks.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut result = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        result |= x ^ y;
    }
    result == 0
}

/// Challenge echo in credential (echoes server challenge parameters).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChallengeEcho {
    pub id: String,
    pub realm: String,
    pub method: MethodName,
    pub intent: IntentName,
    pub request: Base64UrlJson,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opaque: Option<Base64UrlJson>,
}

/// Payment credential from client (sent in Authorization header).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentCredential {
    pub challenge: ChallengeEcho,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Payment payload (method/intent-specific JSON).
    pub payload: serde_json::Value,
}

impl PaymentCredential {
    pub fn new(challenge: ChallengeEcho, payload: impl Serialize) -> Self {
        Self {
            challenge,
            source: None,
            payload: serde_json::to_value(payload).expect("payload must be serializable"),
        }
    }

    pub fn with_source(
        challenge: ChallengeEcho,
        source: impl Into<String>,
        payload: impl Serialize,
    ) -> Self {
        Self {
            challenge,
            source: Some(source.into()),
            payload: serde_json::to_value(payload).expect("payload must be serializable"),
        }
    }

    /// Parse from an Authorization header value.
    pub fn from_header(header: &str) -> Result<Self, crate::error::Error> {
        super::parse_authorization(header)
    }

    /// Deserialize the payload as a specific type.
    pub fn payload_as<T: serde::de::DeserializeOwned>(&self) -> Result<T, crate::error::Error> {
        serde_json::from_value(self.payload.clone())
            .map_err(|e| crate::error::Error::Other(format!("payload deserialization failed: {e}")))
    }

    /// Create a DID for a Solana address.
    ///
    /// Format: `did:pkh:solana:{chain_id}:{address}`
    pub fn solana_did(chain_id: &str, address: &str) -> String {
        format!("did:pkh:solana:{chain_id}:{address}")
    }
}

/// Payment receipt from server (parsed from Payment-Receipt header).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub status: ReceiptStatus,
    pub method: MethodName,
    pub timestamp: String,
    pub reference: String,
    #[serde(rename = "challengeId", skip_serializing_if = "Option::is_none")]
    pub challenge_id: Option<String>,
}

impl Receipt {
    /// Create a successful payment receipt.
    pub fn success(method: impl Into<MethodName>, reference: impl Into<String>) -> Self {
        Self {
            status: ReceiptStatus::Success,
            method: method.into(),
            timestamp: now_iso8601(),
            reference: reference.into(),
            challenge_id: None,
        }
    }

    pub fn with_challenge_id(mut self, id: impl Into<String>) -> Self {
        self.challenge_id = Some(id.into());
        self
    }

    pub fn is_success(&self) -> bool {
        self.status == ReceiptStatus::Success
    }

    /// Format as Payment-Receipt header value.
    pub fn to_header(&self) -> Result<String, crate::error::Error> {
        super::format_receipt(self)
    }
}

fn now_iso8601() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_hmac_verify() {
        let challenge = PaymentChallenge::with_secret_key(
            "test-secret",
            "api.example.com",
            "solana",
            "charge",
            Base64UrlJson::from_value(&serde_json::json!({"amount": "1000"})).unwrap(),
        );
        assert!(challenge.verify("test-secret"));
        assert!(!challenge.verify("wrong-secret"));
    }

    #[test]
    fn challenge_echo_roundtrip() {
        let challenge = PaymentChallenge::new(
            "id-123",
            "realm",
            "solana",
            "charge",
            Base64UrlJson::from_value(&serde_json::json!({"amount": "1000"})).unwrap(),
        );
        let echo = challenge.to_echo();
        assert_eq!(echo.id, "id-123");
        assert_eq!(echo.method.as_str(), "solana");
    }

    #[test]
    fn receipt_creation() {
        let receipt = Receipt::success("solana", "5UfDuX...");
        assert!(receipt.is_success());
        assert_eq!(receipt.method.as_str(), "solana");
    }
}
