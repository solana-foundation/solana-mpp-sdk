//! Intent-specific request types.

mod charge;

pub use charge::ChargeRequest;

/// Convert a human-readable amount to base units.
///
/// Matches the TypeScript SDK's `parseUnits(amount, decimals)`.
/// e.g., `parse_units("1.5", 6)` → `"1500000"`.
pub fn parse_units(amount: &str, decimals: u8) -> Result<String, crate::error::Error> {
    let decimals = decimals as u32;

    if let Some((integer, fraction)) = amount.split_once('.') {
        let frac_len = fraction.len() as u32;
        if frac_len > decimals {
            return Err(crate::error::Error::Other(format!(
                "Too many decimal places: {frac_len} > {decimals}"
            )));
        }
        let padding = decimals - frac_len;
        let combined = format!("{integer}{fraction}{}", "0".repeat(padding as usize));
        // Strip leading zeros but keep at least one digit.
        let trimmed = combined.trim_start_matches('0');
        if trimmed.is_empty() {
            Ok("0".to_string())
        } else {
            Ok(trimmed.to_string())
        }
    } else {
        // No decimal point — multiply by 10^decimals.
        let value: u128 = amount
            .parse()
            .map_err(|_| crate::error::Error::Other(format!("Invalid amount: {amount}")))?;
        let factor = 10u128.pow(decimals);
        Ok((value * factor).to_string())
    }
}

/// Deserialize a request from a base64url JSON string.
pub fn deserialize_request<T: serde::de::DeserializeOwned>(
    request_b64: &str,
) -> Result<T, crate::error::Error> {
    let bytes = crate::protocol::core::base64url_decode(request_b64)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| crate::error::Error::Other(format!("Failed to deserialize request: {e}")))
}

/// Serialize a request to a base64url JSON string.
pub fn serialize_request<T: serde::Serialize>(request: &T) -> Result<String, crate::error::Error> {
    let json = serde_json_canonicalizer::to_string(request)
        .map_err(|e| crate::error::Error::Other(format!("Canonical JSON failed: {e}")))?;
    Ok(crate::protocol::core::base64url_encode(json.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_units_integer() {
        assert_eq!(parse_units("1", 6).unwrap(), "1000000");
        assert_eq!(parse_units("0", 6).unwrap(), "0");
    }

    #[test]
    fn parse_units_decimal() {
        assert_eq!(parse_units("1.5", 6).unwrap(), "1500000");
        assert_eq!(parse_units("0.01", 6).unwrap(), "10000");
    }

    #[test]
    fn parse_units_too_many_decimals() {
        assert!(parse_units("1.1234567", 6).is_err());
    }
}
