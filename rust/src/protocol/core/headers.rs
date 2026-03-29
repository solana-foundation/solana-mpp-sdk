//! Header parsing and formatting for Web Payment Auth.
//!
//! No regex — minimal dependencies.

use super::challenge::{PaymentChallenge, PaymentCredential, Receipt};
use super::types::{base64url_decode, base64url_encode, Base64UrlJson, IntentName, MethodName};
use crate::error::Error;
use std::collections::HashMap;

const MAX_TOKEN_LEN: usize = 16 * 1024;

/// Header name for payment challenges (from server).
pub const WWW_AUTHENTICATE_HEADER: &str = "www-authenticate";

/// Header name for payment credentials (from client).
pub const AUTHORIZATION_HEADER: &str = "authorization";

/// Header name for payment receipts (from server).
pub const PAYMENT_RECEIPT_HEADER: &str = "payment-receipt";

/// Scheme identifier for the Payment authentication scheme.
pub const PAYMENT_SCHEME: &str = "Payment";

/// Parse a single WWW-Authenticate header into a PaymentChallenge.
pub fn parse_www_authenticate(header: &str) -> Result<PaymentChallenge, Error> {
    let rest = strip_payment_scheme(header)
        .ok_or_else(|| Error::Other("Expected 'Payment' scheme".into()))?;

    let params_str = rest
        .strip_prefix(' ')
        .or_else(|| rest.strip_prefix('\t'))
        .ok_or_else(|| Error::Other("Expected space after 'Payment' scheme".into()))?
        .trim_start();
    let params = parse_auth_params(params_str)?;

    let id = require_param(&params, "id")?.clone();
    if id.is_empty() {
        return Err(Error::Other("Empty 'id' parameter".into()));
    }
    let realm = require_param(&params, "realm")?.clone();
    let method_raw = require_param(&params, "method")?.clone();
    if method_raw.is_empty() || !method_raw.chars().all(|c| c.is_ascii_lowercase()) {
        return Err(Error::Other(format!(
            "Invalid method: \"{method_raw}\". Must be lowercase ASCII."
        )));
    }
    let method = MethodName::new(method_raw);
    let intent = IntentName::new(require_param(&params, "intent")?);
    let request_b64 = require_param(&params, "request")?.clone();

    let request_bytes = base64url_decode(&request_b64)?;
    let _ = serde_json::from_slice::<serde_json::Value>(&request_bytes)
        .map_err(|e| Error::Other(format!("Invalid JSON in request field: {e}")))?;
    let request = Base64UrlJson::from_raw(request_b64);

    Ok(PaymentChallenge {
        id,
        realm,
        method,
        intent,
        request,
        expires: params.get("expires").cloned(),
        description: params.get("description").cloned(),
        digest: params.get("digest").cloned(),
        opaque: params.get("opaque").map(Base64UrlJson::from_raw),
    })
}

/// Parse all Payment challenges from multiple WWW-Authenticate header values.
pub fn parse_www_authenticate_all<'a>(
    headers: impl IntoIterator<Item = &'a str>,
) -> Vec<Result<PaymentChallenge, Error>> {
    headers
        .into_iter()
        .filter(|h| {
            h.trim_start()
                .get(..8)
                .is_some_and(|s| s.eq_ignore_ascii_case("payment "))
        })
        .map(parse_www_authenticate)
        .collect()
}

/// Format a PaymentChallenge as a WWW-Authenticate header value.
pub fn format_www_authenticate(challenge: &PaymentChallenge) -> Result<String, Error> {
    let mut parts = vec![
        format!("id=\"{}\"", escape_quoted_value(&challenge.id)?),
        format!("realm=\"{}\"", escape_quoted_value(&challenge.realm)?),
        format!(
            "method=\"{}\"",
            escape_quoted_value(challenge.method.as_str())?
        ),
        format!(
            "intent=\"{}\"",
            escape_quoted_value(challenge.intent.as_str())?
        ),
        format!(
            "request=\"{}\"",
            escape_quoted_value(challenge.request.raw())?
        ),
    ];

    if let Some(ref expires) = challenge.expires {
        parts.push(format!("expires=\"{}\"", escape_quoted_value(expires)?));
    }
    if let Some(ref description) = challenge.description {
        parts.push(format!(
            "description=\"{}\"",
            escape_quoted_value(description)?
        ));
    }
    if let Some(ref digest) = challenge.digest {
        parts.push(format!("digest=\"{}\"", escape_quoted_value(digest)?));
    }
    if let Some(ref opaque) = challenge.opaque {
        parts.push(format!("opaque=\"{}\"", escape_quoted_value(opaque.raw())?));
    }

    Ok(format!("Payment {}", parts.join(", ")))
}

/// Format multiple challenges as WWW-Authenticate header values.
pub fn format_www_authenticate_many(challenges: &[PaymentChallenge]) -> Result<Vec<String>, Error> {
    challenges.iter().map(format_www_authenticate).collect()
}

/// Parse an Authorization header into a PaymentCredential.
pub fn parse_authorization(header: &str) -> Result<PaymentCredential, Error> {
    let payment_part = extract_payment_scheme(header)
        .ok_or_else(|| Error::Other("Expected 'Payment' scheme".into()))?;

    let token = payment_part.get(8..).unwrap_or("").trim();

    if token.len() > MAX_TOKEN_LEN {
        return Err(Error::Other(format!(
            "Token exceeds maximum length of {MAX_TOKEN_LEN} bytes"
        )));
    }

    let decoded = base64url_decode(token)?;
    let credential: PaymentCredential = serde_json::from_slice(&decoded)
        .map_err(|e| Error::Other(format!("Invalid credential JSON: {e}")))?;

    Ok(credential)
}

/// Format a PaymentCredential as an Authorization header value.
pub fn format_authorization(credential: &PaymentCredential) -> Result<String, Error> {
    let json = serde_json::to_string(credential)
        .map_err(|e| Error::Other(format!("JSON serialization failed: {e}")))?;
    let encoded = base64url_encode(json.as_bytes());
    Ok(format!("Payment {encoded}"))
}

/// Parse a Payment-Receipt header into a Receipt.
pub fn parse_receipt(header: &str) -> Result<Receipt, Error> {
    let token = header.trim();
    if token.len() > MAX_TOKEN_LEN {
        return Err(Error::Other(format!(
            "Receipt exceeds maximum length of {MAX_TOKEN_LEN} bytes"
        )));
    }

    let decoded = base64url_decode(token)?;
    let receipt: Receipt = serde_json::from_slice(&decoded)
        .map_err(|e| Error::Other(format!("Invalid receipt JSON: {e}")))?;
    Ok(receipt)
}

/// Format a Receipt as a Payment-Receipt header value.
pub fn format_receipt(receipt: &Receipt) -> Result<String, Error> {
    let json = serde_json::to_string(receipt)
        .map_err(|e| Error::Other(format!("JSON serialization failed: {e}")))?;
    Ok(base64url_encode(json.as_bytes()))
}

/// Extract the `Payment` scheme from an Authorization header.
pub fn extract_payment_scheme(header: &str) -> Option<&str> {
    header.split(',').map(|s| s.trim()).find(|s| {
        s.len() >= 8
            && s.get(..8)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("payment "))
    })
}

// ── Private helpers ──

fn strip_payment_scheme(header: &str) -> Option<&str> {
    let header = header.trim_start();
    let scheme_len = PAYMENT_SCHEME.len();
    if header.len() >= scheme_len
        && header
            .get(..scheme_len)
            .is_some_and(|s| s.eq_ignore_ascii_case(PAYMENT_SCHEME))
    {
        header.get(scheme_len..)
    } else {
        None
    }
}

fn escape_quoted_value(s: &str) -> Result<String, Error> {
    if s.contains('\r') || s.contains('\n') {
        return Err(Error::Other(
            "Header value contains invalid CRLF characters".into(),
        ));
    }
    Ok(s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn require_param<'a>(params: &'a HashMap<String, String>, key: &str) -> Result<&'a String, Error> {
    params
        .get(key)
        .ok_or_else(|| Error::Other(format!("Missing '{key}' field")))
}

fn parse_auth_params(params_str: &str) -> Result<HashMap<String, String>, Error> {
    let mut params = HashMap::new();
    let chars: Vec<char> = params_str.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == ',') {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }

        let key_start = i;
        while i < chars.len() && chars[i] != '=' && !chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() || chars[i] != '=' {
            while i < chars.len() && !chars[i].is_whitespace() && chars[i] != ',' {
                i += 1;
            }
            continue;
        }

        let key: String = chars[key_start..i].iter().collect();
        i += 1;

        if i >= chars.len() {
            break;
        }

        let value = if chars[i] == '"' {
            i += 1;
            let mut value = String::new();
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                    value.push(chars[i]);
                } else {
                    value.push(chars[i]);
                }
                i += 1;
            }
            if i < chars.len() {
                i += 1;
            }
            value
        } else {
            let value_start = i;
            while i < chars.len() && !chars[i].is_whitespace() && chars[i] != ',' {
                i += 1;
            }
            chars[value_start..i].iter().collect()
        };

        if params.contains_key(&key) {
            return Err(Error::Other(format!("Duplicate parameter: {key}")));
        }
        params.insert(key, value);
    }

    Ok(params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::core::types::ReceiptStatus;

    fn test_challenge() -> PaymentChallenge {
        PaymentChallenge {
            id: "abc123".to_string(),
            realm: "api".to_string(),
            method: "solana".into(),
            intent: "charge".into(),
            request: Base64UrlJson::from_value(&serde_json::json!({
                "amount": "10000",
                "currency": "USDC"
            }))
            .unwrap(),
            expires: Some("2024-01-01T00:00:00Z".to_string()),
            description: None,
            digest: None,
            opaque: None,
        }
    }

    #[test]
    fn www_authenticate_roundtrip() {
        let challenge = test_challenge();
        let header = format_www_authenticate(&challenge).unwrap();
        let parsed = parse_www_authenticate(&header).unwrap();
        assert_eq!(parsed.id, "abc123");
        assert_eq!(parsed.realm, "api");
        assert_eq!(parsed.method.as_str(), "solana");
        assert_eq!(parsed.intent.as_str(), "charge");
    }

    #[test]
    fn authorization_roundtrip() {
        let challenge = test_challenge();
        let payload = serde_json::json!({"type": "transaction", "transaction": "base64tx"});
        let credential = PaymentCredential::new(challenge.to_echo(), payload);
        let header = format_authorization(&credential).unwrap();
        let parsed = parse_authorization(&header).unwrap();
        assert_eq!(parsed.challenge.id, "abc123");
    }

    #[test]
    fn receipt_roundtrip() {
        let receipt = Receipt {
            status: ReceiptStatus::Success,
            method: "solana".into(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            reference: "5UfDuX...".to_string(),
            challenge_id: None,
        };
        let header = format_receipt(&receipt).unwrap();
        let parsed = parse_receipt(&header).unwrap();
        assert_eq!(parsed.reference, "5UfDuX...");
    }

    #[test]
    fn parse_rejects_non_payment() {
        assert!(parse_www_authenticate("Bearer realm=\"test\"").is_err());
    }

    #[test]
    fn parse_rejects_duplicate_params() {
        let header = r#"Payment id="a", realm="api", method="solana", intent="charge", request="e30", id="b""#;
        assert!(parse_www_authenticate(header).is_err());
    }

    #[test]
    fn extract_payment_scheme_mixed() {
        let header = "Bearer token123, Payment eyJhYmMi";
        let result = extract_payment_scheme(header);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "Payment eyJhYmMi");
    }
}
