use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_keychain::SolanaSigner;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_rpc_client::rpc_client::RpcClient;
use solana_signature::Signature;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::Transaction;
use std::str::FromStr;

use crate::error::Error;
use crate::protocol::methods::solana::{
    programs, CredentialPayload, MppChallenge, MppRequest, SolanaMethodDetails, Split,
};

/// Build a charge transaction from the challenge parameters.
///
/// Returns a `CredentialPayload::Transaction` with the signed (or
/// partially signed) transaction ready to send to the server.
pub async fn build_charge_transaction(
    signer: &dyn SolanaSigner,
    rpc: &RpcClient,
    amount: &str,
    currency: &str,
    recipient: &str,
    method_details: &SolanaMethodDetails,
) -> Result<CredentialPayload, Error> {
    let total_amount: u64 = amount
        .parse()
        .map_err(|_| Error::Other(format!("Invalid amount: {amount}")))?;

    let splits = method_details.splits.as_deref().unwrap_or(&[]);
    if splits.len() > 8 {
        return Err(Error::TooManySplits);
    }

    let splits_total: u64 = splits
        .iter()
        .filter_map(|s| s.amount.parse::<u64>().ok())
        .sum();
    let primary_amount = total_amount
        .checked_sub(splits_total)
        .ok_or(Error::SplitsExceedAmount)?;
    if primary_amount == 0 {
        return Err(Error::SplitsExceedAmount);
    }

    let signer_pubkey = signer.pubkey();

    let recipient_pubkey =
        Pubkey::from_str(recipient).map_err(|e| Error::Other(format!("Invalid recipient: {e}")))?;

    let use_fee_payer =
        method_details.fee_payer.unwrap_or(false) && method_details.fee_payer_key.is_some();

    let fee_payer_pubkey = if use_fee_payer {
        let key = method_details.fee_payer_key.as_ref().unwrap();
        Some(Pubkey::from_str(key).map_err(|e| Error::Other(format!("Invalid fee payer: {e}")))?)
    } else {
        None
    };

    let mut instructions = Vec::new();

    // Compute budget.
    instructions.push(compute_unit_price_ix(1));
    instructions.push(compute_unit_limit_ix(200_000));

    let mint = resolve_mint(currency, method_details.network.as_deref());

    if let Some(mint_str) = mint {
        build_spl_instructions(
            &mut instructions,
            &signer_pubkey,
            &recipient_pubkey,
            rpc,
            mint_str,
            method_details,
            primary_amount,
            splits,
            fee_payer_pubkey.as_ref(),
        )?;
    } else {
        build_sol_instructions(
            &mut instructions,
            &signer_pubkey,
            &recipient_pubkey,
            primary_amount,
            splits,
        )?;
    }

    // Build and sign.
    let blockhash = if let Some(bh) = &method_details.recent_blockhash {
        Hash::from_str(bh).map_err(|e| Error::Other(format!("Invalid blockhash: {e}")))?
    } else {
        rpc.get_latest_blockhash()
            .map_err(|e| Error::Rpc(e.to_string()))?
    };

    let actual_fee_payer = fee_payer_pubkey.unwrap_or(signer_pubkey);
    let message = Message::new_with_blockhash(&instructions, Some(&actual_fee_payer), &blockhash);
    let mut tx = Transaction::new_unsigned(message);

    // Sign the transaction message using keychain's signer.
    let sig_bytes = signer
        .sign_message(&tx.message_data())
        .await
        .map_err(|e| Error::Other(format!("Signing failed: {e}")))?;
    let sig = Signature::from(<[u8; 64]>::from(sig_bytes));
    let signer_index = tx
        .message
        .account_keys
        .iter()
        .position(|k| k == &signer_pubkey)
        .ok_or_else(|| Error::Other("Signer not found in transaction accounts".to_string()))?;
    tx.signatures[signer_index] = sig;

    let serialized =
        bincode::serialize(&tx).map_err(|e| Error::Other(format!("Serialization failed: {e}")))?;
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &serialized);

    Ok(CredentialPayload::Transaction {
        transaction: encoded,
    })
}

/// Parse an MPP challenge from the `www-authenticate` header value.
///
/// Supports the mppx format:
/// ```text
/// Payment id="...", realm="MPP Payment", method="solana", intent="charge", request="<base64url>"
/// ```
pub fn parse_www_authenticate(header_value: &str) -> Option<MppChallenge> {
    if !header_value.starts_with("Payment ") || !header_value.contains("method=\"solana\"") {
        return None;
    }

    let id = extract_quoted_param(header_value, "id")?;
    let realm = extract_quoted_param(header_value, "realm").unwrap_or_default();
    let method = extract_quoted_param(header_value, "method")?;
    let intent = extract_quoted_param(header_value, "intent").unwrap_or_default();
    let request_encoded = extract_quoted_param(header_value, "request")?;
    let description = extract_quoted_param(header_value, "description");
    let expires = extract_quoted_param(header_value, "expires");

    use base64::Engine;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&request_encoded)
        .or_else(|_| {
            let padded = pad_base64(&request_encoded);
            base64::engine::general_purpose::STANDARD.decode(padded.as_bytes())
        })
        .ok()?;
    let request: MppRequest = serde_json::from_slice(&decoded).ok()?;

    Some(MppChallenge {
        id,
        realm,
        method,
        intent,
        request_encoded,
        description,
        expires,
        request,
    })
}

/// Build a credential and return the `Authorization` header value.
///
/// Returns `"Payment <base64url(credential_json)>"`.
pub async fn build_credential_header(
    signer: &dyn SolanaSigner,
    rpc: &RpcClient,
    challenge: &MppChallenge,
) -> Result<String, Error> {
    let credential_payload = build_charge_transaction(
        signer,
        rpc,
        &challenge.request.amount,
        &challenge.request.currency,
        &challenge.request.recipient,
        &challenge.request.method_details,
    )
    .await?;

    let mut challenge_wire = serde_json::json!({
        "id": challenge.id,
        "realm": challenge.realm,
        "method": challenge.method,
        "intent": challenge.intent,
        "request": challenge.request_encoded,
    });
    if let Some(desc) = &challenge.description {
        challenge_wire["description"] = serde_json::json!(desc);
    }
    if let Some(exp) = &challenge.expires {
        challenge_wire["expires"] = serde_json::json!(exp);
    }

    let credential = serde_json::json!({
        "challenge": challenge_wire,
        "payload": credential_payload,
    });

    use base64::Engine;
    let json_str = serde_json::to_string(&credential)
        .map_err(|e| Error::Other(format!("JSON serialization failed: {e}")))?;
    let encoded =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json_str.as_bytes());
    Ok(format!("Payment {encoded}"))
}

fn extract_quoted_param(header: &str, param: &str) -> Option<String> {
    let prefix = format!("{param}=\"");
    let start = header.find(&prefix)? + prefix.len();
    let rest = &header[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn pad_base64(input: &str) -> String {
    let rem = input.len() % 4;
    if rem == 0 {
        input.to_string()
    } else {
        format!("{}{}", input, "=".repeat(4 - rem))
    }
}

// ── Compute budget instructions (inline, no heavy dep) ──

fn compute_unit_price_ix(micro_lamports: u64) -> Instruction {
    let program_id = Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap();
    let mut data = vec![3u8]; // SetComputeUnitPrice discriminator
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction {
        program_id,
        accounts: vec![],
        data,
    }
}

fn compute_unit_limit_ix(units: u32) -> Instruction {
    let program_id = Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap();
    let mut data = vec![2u8]; // SetComputeUnitLimit discriminator
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id,
        accounts: vec![],
        data,
    }
}

// ── Private helpers ──

fn build_sol_instructions(
    instructions: &mut Vec<Instruction>,
    signer_pubkey: &Pubkey,
    recipient: &Pubkey,
    primary_amount: u64,
    splits: &[Split],
) -> Result<(), Error> {
    instructions.push(system_instruction::transfer(
        signer_pubkey,
        recipient,
        primary_amount,
    ));

    for split in splits {
        let split_recipient = Pubkey::from_str(&split.recipient)
            .map_err(|e| Error::Other(format!("Invalid split recipient: {e}")))?;
        let split_amount: u64 = split
            .amount
            .parse()
            .map_err(|_| Error::Other(format!("Invalid split amount: {}", split.amount)))?;
        instructions.push(system_instruction::transfer(
            signer_pubkey,
            &split_recipient,
            split_amount,
        ));
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_spl_instructions(
    instructions: &mut Vec<Instruction>,
    signer_pubkey: &Pubkey,
    recipient: &Pubkey,
    rpc: &RpcClient,
    spl: &str,
    method_details: &SolanaMethodDetails,
    primary_amount: u64,
    splits: &[Split],
    fee_payer: Option<&Pubkey>,
) -> Result<(), Error> {
    let mint =
        Pubkey::from_str(spl).map_err(|e| Error::Other(format!("Invalid mint: {e}")))?;
    let token_program = resolve_token_program(rpc, &mint, method_details)?;
    let decimals = method_details.decimals.unwrap_or(6);

    let source_ata = get_associated_token_address(signer_pubkey, &mint, &token_program);

    let payer = fee_payer.copied().unwrap_or(*signer_pubkey);

    let mut add_spl_transfer = |dest_owner: &Pubkey, transfer_amount: u64| -> Result<(), Error> {
        let dest_ata = get_associated_token_address(dest_owner, &mint, &token_program);

        instructions.push(create_associated_token_account_idempotent(
            &payer,
            dest_owner,
            &mint,
            &token_program,
        ));

        instructions.push(transfer_checked_ix(
            &token_program,
            &source_ata,
            &mint,
            &dest_ata,
            signer_pubkey,
            transfer_amount,
            decimals,
        ));

        Ok(())
    };

    add_spl_transfer(recipient, primary_amount)?;

    for split in splits {
        let split_recipient = Pubkey::from_str(&split.recipient)
            .map_err(|e| Error::Other(format!("Invalid split recipient: {e}")))?;
        let split_amount: u64 = split
            .amount
            .parse()
            .map_err(|_| Error::Other(format!("Invalid split amount: {}", split.amount)))?;
        add_spl_transfer(&split_recipient, split_amount)?;
    }

    Ok(())
}

fn resolve_token_program(
    rpc: &RpcClient,
    mint: &Pubkey,
    method_details: &SolanaMethodDetails,
) -> Result<Pubkey, Error> {
    let token_program = if let Some(token_program) = method_details.token_program.as_deref() {
        Pubkey::from_str(token_program)
            .map_err(|e| Error::Other(format!("Invalid token program: {e}")))?
    } else {
        rpc.get_account(mint)
            .map_err(|e| Error::Rpc(format!("Failed to fetch mint account: {e}")))?
            .owner
    };

    let token_program_str = token_program.to_string();
    if token_program_str != programs::TOKEN_PROGRAM
        && token_program_str != programs::TOKEN_2022_PROGRAM
    {
        return Err(Error::Other(format!(
            "Unsupported token program: {token_program}"
        )));
    }

    Ok(token_program)
}

/// Derive the Associated Token Account address (PDA).
fn get_associated_token_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    let ata_program = Pubkey::from_str(programs::ASSOCIATED_TOKEN_PROGRAM).unwrap();
    let seeds = &[owner.as_ref(), token_program.as_ref(), mint.as_ref()];
    Pubkey::find_program_address(seeds, &ata_program).0
}

/// Build a CreateAssociatedTokenAccountIdempotent instruction manually.
fn create_associated_token_account_idempotent(
    payer: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    let ata = get_associated_token_address(owner, mint, token_program);
    let ata_program = Pubkey::from_str(programs::ASSOCIATED_TOKEN_PROGRAM).unwrap();
    let system_program = Pubkey::from_str(programs::SYSTEM_PROGRAM).unwrap();

    Instruction {
        program_id: ata_program,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: vec![1], // CreateIdempotent discriminator
    }
}

/// Build a TransferChecked instruction manually.
fn transfer_checked_ix(
    token_program: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);

    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// Resolve a currency to an optional mint address.
///
/// Returns `None` for native SOL, or `Some(mint_address)` for SPL tokens.
/// Supports well-known symbols (USDC, PYUSD) and raw mint addresses.
fn resolve_mint<'a>(currency: &'a str, network: Option<&str>) -> Option<&'a str> {
    match currency.to_uppercase().as_str() {
        "SOL" => None,
        "USDC" => Some(match network {
            Some("devnet") => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            _ => "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        }),
        "PYUSD" => Some(match network {
            Some("devnet") => "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
            _ => "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
        }),
        // If it's not a known symbol, assume it's already a mint address
        _ => Some(currency),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mppx_www_authenticate() {
        use base64::Engine;
        let request_json = serde_json::json!({
            "amount": "10000",
            "currency": "USDC",
            "recipient": "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
            "methodDetails": {
                "network": "devnet",
                "decimals": 6,
                "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            }
        });
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&request_json).unwrap());
        let header = format!(
            "Payment id=\"abc123\", realm=\"MPP Payment\", method=\"solana\", intent=\"charge\", request=\"{b64}\""
        );

        let parsed = parse_www_authenticate(&header).unwrap();
        assert_eq!(parsed.id, "abc123");
        assert_eq!(parsed.realm, "MPP Payment");
        assert_eq!(parsed.method, "solana");
        assert_eq!(parsed.intent, "charge");
        assert_eq!(parsed.request.amount, "10000");
        assert_eq!(parsed.request.currency, "USDC");
        assert_eq!(parsed.request.method_details.network.as_deref(), Some("devnet"));
    }

    #[test]
    fn parse_www_authenticate_with_description_and_expires() {
        use base64::Engine;
        let request_json = serde_json::json!({
            "amount": "5000",
            "currency": "SOL",
            "recipient": "So11111111111111111111111111111111111111112",
            "methodDetails": { "network": "localnet" }
        });
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&request_json).unwrap());
        let header = format!(
            "Payment id=\"x\", realm=\"test\", method=\"solana\", intent=\"charge\", request=\"{b64}\", description=\"Weather data\", expires=\"2026-12-31T00:00:00Z\""
        );

        let parsed = parse_www_authenticate(&header).unwrap();
        assert_eq!(parsed.description.as_deref(), Some("Weather data"));
        assert_eq!(parsed.expires.as_deref(), Some("2026-12-31T00:00:00Z"));
    }

    #[test]
    fn parse_non_payment_header() {
        assert!(parse_www_authenticate("Bearer realm=\"api\"").is_none());
    }

    #[test]
    fn parse_non_solana_method() {
        assert!(
            parse_www_authenticate("Payment id=\"x\", method=\"bitcoin\", request=\"abc\"")
                .is_none()
        );
    }

    #[test]
    fn extract_param_works() {
        let h = "Payment id=\"abc\", method=\"solana\", realm=\"test\"";
        assert_eq!(extract_quoted_param(h, "id"), Some("abc".to_string()));
        assert_eq!(extract_quoted_param(h, "method"), Some("solana".to_string()));
        assert_eq!(extract_quoted_param(h, "realm"), Some("test".to_string()));
        assert_eq!(extract_quoted_param(h, "missing"), None);
    }

    #[test]
    fn pad_base64_works() {
        assert_eq!(pad_base64("abc"), "abc=");
        assert_eq!(pad_base64("ab"), "ab==");
        assert_eq!(pad_base64("abcd"), "abcd");
        assert_eq!(pad_base64("a"), "a===");
    }

    #[test]
    fn resolve_mint_known_symbols() {
        assert_eq!(resolve_mint("SOL", None), None);
        assert_eq!(resolve_mint("sol", None), None);
        assert_eq!(
            resolve_mint("USDC", None),
            Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
        );
        assert_eq!(
            resolve_mint("USDC", Some("devnet")),
            Some("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
        );
    }

    #[test]
    fn resolve_mint_passthrough() {
        assert_eq!(
            resolve_mint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", None),
            Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
        );
    }
}
