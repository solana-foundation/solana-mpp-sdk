use anchor_lang::prelude::*;

/// Parse a JCS-serialized voucher message to extract channelId and cumulativeAmount.
///
/// The voucher message is JCS-canonicalized JSON with sorted keys:
///   {"channelId":"<base58>","cumulativeAmount":"<digits>"}
/// or with expiresAt:
///   {"channelId":"<base58>","cumulativeAmount":"<digits>","expiresAt":"<iso8601>"}
///
/// The on-chain program receives these raw bytes (which were signed by the
/// client) and validates that the channelId matches the channel PDA and the
/// cumulativeAmount matches the settle instruction's argument.
pub struct ParsedVoucherMessage {
    pub channel_id_bytes: Vec<u8>,
    pub cumulative_amount: u64,
}

/// Parse a JCS voucher message and extract channelId (as raw base58 bytes)
/// and cumulativeAmount (as u64).
///
/// Returns None if the message doesn't match the expected JCS format.
pub fn parse_jcs_voucher_message(message: &[u8]) -> Option<ParsedVoucherMessage> {
    // Expected format: {"channelId":"...","cumulativeAmount":"..."}
    // or {"channelId":"...","cumulativeAmount":"...","expiresAt":"..."}
    let prefix = b"{\"channelId\":\"";
    if !message.starts_with(prefix) {
        return None;
    }

    let after_prefix = &message[prefix.len()..];

    // Find end of channelId value
    let channel_id_end = find_byte(after_prefix, b'"')?;
    let channel_id_bytes = after_prefix[..channel_id_end].to_vec();

    // Skip to cumulativeAmount
    let after_channel_id = &after_prefix[channel_id_end..];
    let cumulative_prefix = b"\",\"cumulativeAmount\":\"";
    if !after_channel_id.starts_with(cumulative_prefix) {
        return None;
    }

    let after_cumulative_prefix = &after_channel_id[cumulative_prefix.len()..];

    // Find end of cumulativeAmount value
    let amount_end = find_byte(after_cumulative_prefix, b'"')?;
    let amount_str = core::str::from_utf8(&after_cumulative_prefix[..amount_end]).ok()?;
    let cumulative_amount: u64 = amount_str.parse().ok()?;

    Some(ParsedVoucherMessage {
        channel_id_bytes,
        cumulative_amount,
    })
}

/// Verify that the parsed channelId (base58 string) decodes to the expected pubkey.
pub fn verify_channel_id(channel_id_bytes: &[u8], expected: &Pubkey) -> bool {
    let channel_id_str = match core::str::from_utf8(channel_id_bytes) {
        Ok(s) => s,
        Err(_) => return false,
    };

    // Use Pubkey's FromStr implementation which handles base58 decoding.
    match channel_id_str.parse::<Pubkey>() {
        Ok(decoded) => decoded == *expected,
        Err(_) => false,
    }
}

fn find_byte(data: &[u8], byte: u8) -> Option<usize> {
    data.iter().position(|&b| b == byte)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_voucher_without_expires() {
        let message = br#"{"channelId":"11111111111111111111111111111112","cumulativeAmount":"1000000"}"#;
        let parsed = parse_jcs_voucher_message(message).unwrap();
        assert_eq!(parsed.cumulative_amount, 1_000_000);
        assert_eq!(
            core::str::from_utf8(&parsed.channel_id_bytes).unwrap(),
            "11111111111111111111111111111112"
        );
    }

    #[test]
    fn parse_voucher_with_expires() {
        let message = br#"{"channelId":"11111111111111111111111111111112","cumulativeAmount":"500","expiresAt":"2026-01-01T00:00:00Z"}"#;
        let parsed = parse_jcs_voucher_message(message).unwrap();
        assert_eq!(parsed.cumulative_amount, 500);
    }

    #[test]
    fn reject_invalid_prefix() {
        let message = br#"{"invalid":"data"}"#;
        assert!(parse_jcs_voucher_message(message).is_none());
    }

    #[test]
    fn verify_channel_id_match() {
        let pubkey = Pubkey::default();
        let encoded = pubkey.to_string();
        assert!(verify_channel_id(encoded.as_bytes(), &pubkey));
    }

    #[test]
    fn verify_channel_id_mismatch() {
        let pubkey1 = Pubkey::new_unique();
        let pubkey2 = Pubkey::new_unique();
        let encoded = pubkey1.to_string();
        assert!(!verify_channel_id(encoded.as_bytes(), &pubkey2));
    }
}
