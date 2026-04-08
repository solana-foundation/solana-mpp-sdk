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
use crate::protocol::core::{
    format_authorization, parse_www_authenticate, PaymentChallenge, PaymentCredential,
};
use crate::protocol::solana::{programs, CredentialPayload, MethodDetails, Split};

/// Build a charge transaction from challenge parameters.
///
/// Returns a `CredentialPayload::Transaction` with the signed (or
/// partially signed) transaction ready to send to the server.
pub async fn build_charge_transaction(
    signer: &dyn SolanaSigner,
    rpc: &RpcClient,
    amount: &str,
    currency: &str,
    recipient: &str,
    method_details: &MethodDetails,
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

/// Build a credential from a challenge and return the `Authorization` header value.
///
/// Parses the challenge, builds and signs the transaction, and formats the
/// credential as `"Payment <base64url(credential_json)>"`.
pub async fn build_credential_header(
    signer: &dyn SolanaSigner,
    rpc: &RpcClient,
    challenge: &PaymentChallenge,
) -> Result<String, Error> {
    // Decode the request to get Solana-specific fields.
    let request: crate::protocol::intents::ChargeRequest = challenge
        .request
        .decode()
        .map_err(|e| Error::Other(format!("Failed to decode challenge request: {e}")))?;

    let method_details: MethodDetails = request
        .method_details
        .as_ref()
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .map_err(|e| Error::Other(format!("Invalid method details: {e}")))?
        .unwrap_or_default();

    let recipient = request
        .recipient
        .as_deref()
        .ok_or_else(|| Error::Other("No recipient in challenge".into()))?;

    let payload = build_charge_transaction(
        signer,
        rpc,
        &request.amount,
        &request.currency,
        recipient,
        &method_details,
    )
    .await?;

    let credential = PaymentCredential::new(challenge.to_echo(), payload);
    format_authorization(&credential)
        .map_err(|e| Error::Other(format!("Failed to format credential: {e}")))
}

/// Parse a `WWW-Authenticate` header into a `PaymentChallenge`.
///
/// Convenience re-export — delegates to `protocol::core::parse_www_authenticate`.
pub fn parse_challenge(header_value: &str) -> Result<PaymentChallenge, Error> {
    parse_www_authenticate(header_value)
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

fn build_spl_instructions(
    instructions: &mut Vec<Instruction>,
    signer_pubkey: &Pubkey,
    recipient: &Pubkey,
    rpc: &RpcClient,
    spl: &str,
    method_details: &MethodDetails,
    primary_amount: u64,
    splits: &[Split],
    fee_payer: Option<&Pubkey>,
) -> Result<(), Error> {
    let mint = Pubkey::from_str(spl).map_err(|e| Error::Other(format!("Invalid mint: {e}")))?;
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
    method_details: &MethodDetails,
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

fn get_associated_token_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    let ata_program = Pubkey::from_str(programs::ASSOCIATED_TOKEN_PROGRAM).unwrap();
    let seeds = &[owner.as_ref(), token_program.as_ref(), mint.as_ref()];
    Pubkey::find_program_address(seeds, &ata_program).0
}

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
        _ => Some(currency),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_challenge_from_header() {
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

        let parsed = parse_challenge(&header).unwrap();
        assert_eq!(parsed.id, "abc123");
        assert_eq!(parsed.realm, "MPP Payment");
        assert_eq!(parsed.method.as_str(), "solana");

        // Decode the request
        let req: crate::protocol::intents::ChargeRequest = parsed.request.decode().unwrap();
        assert_eq!(req.amount, "10000");
        assert_eq!(req.currency, "USDC");
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

    // ── resolve_mint additional coverage ──

    #[test]
    fn resolve_mint_pyusd_mainnet() {
        assert_eq!(
            resolve_mint("PYUSD", None),
            Some("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo")
        );
        assert_eq!(
            resolve_mint("PYUSD", Some("mainnet")),
            Some("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo")
        );
    }

    #[test]
    fn resolve_mint_pyusd_devnet() {
        assert_eq!(
            resolve_mint("PYUSD", Some("devnet")),
            Some("CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM")
        );
    }

    #[test]
    fn resolve_mint_case_insensitive() {
        // "usdc", "Usdc", "uSdC" all resolve the same
        assert_eq!(
            resolve_mint("usdc", None),
            Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
        );
        assert_eq!(
            resolve_mint("Usdc", Some("devnet")),
            Some("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
        );
        assert_eq!(
            resolve_mint("pyusd", None),
            Some("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo")
        );
    }

    #[test]
    fn resolve_mint_unknown_token_returned_as_is() {
        assert_eq!(resolve_mint("BONK", None), Some("BONK"));
        assert_eq!(
            resolve_mint("SomeRandomMint123", Some("devnet")),
            Some("SomeRandomMint123")
        );
    }

    // ── compute budget instruction tests ──

    #[test]
    fn compute_unit_price_ix_structure() {
        let ix = compute_unit_price_ix(42);
        let expected_program =
            Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap();
        assert_eq!(ix.program_id, expected_program);
        assert!(ix.accounts.is_empty());
        assert_eq!(ix.data[0], 3u8); // SetComputeUnitPrice discriminator
        let price = u64::from_le_bytes(ix.data[1..9].try_into().unwrap());
        assert_eq!(price, 42);
    }

    #[test]
    fn compute_unit_price_ix_zero() {
        let ix = compute_unit_price_ix(0);
        let price = u64::from_le_bytes(ix.data[1..9].try_into().unwrap());
        assert_eq!(price, 0);
    }

    #[test]
    fn compute_unit_price_ix_max() {
        let ix = compute_unit_price_ix(u64::MAX);
        let price = u64::from_le_bytes(ix.data[1..9].try_into().unwrap());
        assert_eq!(price, u64::MAX);
    }

    #[test]
    fn compute_unit_limit_ix_structure() {
        let ix = compute_unit_limit_ix(200_000);
        let expected_program =
            Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap();
        assert_eq!(ix.program_id, expected_program);
        assert!(ix.accounts.is_empty());
        assert_eq!(ix.data[0], 2u8); // SetComputeUnitLimit discriminator
        let units = u32::from_le_bytes(ix.data[1..5].try_into().unwrap());
        assert_eq!(units, 200_000);
    }

    #[test]
    fn compute_unit_limit_ix_zero() {
        let ix = compute_unit_limit_ix(0);
        let units = u32::from_le_bytes(ix.data[1..5].try_into().unwrap());
        assert_eq!(units, 0);
    }

    // ── build_sol_instructions tests ──

    #[test]
    fn build_sol_instructions_no_splits() {
        let signer = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let mut instructions = Vec::new();
        build_sol_instructions(&mut instructions, &signer, &recipient, 1_000_000, &[]).unwrap();
        assert_eq!(instructions.len(), 1);
        // The system transfer instruction should use the system program
        let system_program = Pubkey::from_str(programs::SYSTEM_PROGRAM).unwrap();
        assert_eq!(instructions[0].program_id, system_program);
    }

    #[test]
    fn build_sol_instructions_with_splits() {
        let signer = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let split_recipient = Pubkey::new_unique();
        let splits = vec![Split {
            recipient: split_recipient.to_string(),
            amount: "500".to_string(),
            label: None,
            memo: None,
        }];
        let mut instructions = Vec::new();
        build_sol_instructions(&mut instructions, &signer, &recipient, 1_000, &splits).unwrap();
        // 1 primary transfer + 1 split transfer
        assert_eq!(instructions.len(), 2);
    }

    #[test]
    fn build_sol_instructions_invalid_split_recipient() {
        let signer = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let splits = vec![Split {
            recipient: "not-a-pubkey!!!".to_string(),
            amount: "500".to_string(),
            label: None,
            memo: None,
        }];
        let mut instructions = Vec::new();
        let err = build_sol_instructions(&mut instructions, &signer, &recipient, 1_000, &splits);
        assert!(err.is_err());
        let msg = format!("{}", err.unwrap_err());
        assert!(msg.contains("Invalid split recipient"));
    }

    #[test]
    fn build_sol_instructions_invalid_split_amount() {
        let signer = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let split_recipient = Pubkey::new_unique();
        let splits = vec![Split {
            recipient: split_recipient.to_string(),
            amount: "not_a_number".to_string(),
            label: None,
            memo: None,
        }];
        let mut instructions = Vec::new();
        let err = build_sol_instructions(&mut instructions, &signer, &recipient, 1_000, &splits);
        assert!(err.is_err());
        let msg = format!("{}", err.unwrap_err());
        assert!(msg.contains("Invalid split amount"));
    }

    // ── get_associated_token_address tests ──

    #[test]
    fn get_ata_deterministic() {
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let token_program = Pubkey::from_str(programs::TOKEN_PROGRAM).unwrap();
        let ata1 = get_associated_token_address(&owner, &mint, &token_program);
        let ata2 = get_associated_token_address(&owner, &mint, &token_program);
        assert_eq!(ata1, ata2);
    }

    #[test]
    fn get_ata_different_for_different_owners() {
        let owner1 = Pubkey::new_unique();
        let owner2 = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let token_program = Pubkey::from_str(programs::TOKEN_PROGRAM).unwrap();
        let ata1 = get_associated_token_address(&owner1, &mint, &token_program);
        let ata2 = get_associated_token_address(&owner2, &mint, &token_program);
        assert_ne!(ata1, ata2);
    }

    #[test]
    fn get_ata_different_for_different_token_programs() {
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let tp1 = Pubkey::from_str(programs::TOKEN_PROGRAM).unwrap();
        let tp2 = Pubkey::from_str(programs::TOKEN_2022_PROGRAM).unwrap();
        let ata1 = get_associated_token_address(&owner, &mint, &tp1);
        let ata2 = get_associated_token_address(&owner, &mint, &tp2);
        assert_ne!(ata1, ata2);
    }

    // ── create_associated_token_account_idempotent tests ──

    #[test]
    fn create_ata_idempotent_instruction_structure() {
        let payer = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let token_program = Pubkey::from_str(programs::TOKEN_PROGRAM).unwrap();

        let ix = create_associated_token_account_idempotent(&payer, &owner, &mint, &token_program);

        let ata_program = Pubkey::from_str(programs::ASSOCIATED_TOKEN_PROGRAM).unwrap();
        assert_eq!(ix.program_id, ata_program);
        assert_eq!(ix.accounts.len(), 6);
        assert_eq!(ix.data, vec![1]); // CreateIdempotent discriminator

        // payer is signer and writable
        assert_eq!(ix.accounts[0].pubkey, payer);
        assert!(ix.accounts[0].is_signer);
        assert!(ix.accounts[0].is_writable);

        // owner is read-only
        assert_eq!(ix.accounts[2].pubkey, owner);
        assert!(!ix.accounts[2].is_signer);
        assert!(!ix.accounts[2].is_writable);
    }

    // ── transfer_checked_ix tests ──

    #[test]
    fn transfer_checked_ix_structure() {
        let token_program = Pubkey::from_str(programs::TOKEN_PROGRAM).unwrap();
        let source = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let dest = Pubkey::new_unique();
        let authority = Pubkey::new_unique();

        let ix = transfer_checked_ix(&token_program, &source, &mint, &dest, &authority, 42_000, 6);

        assert_eq!(ix.program_id, token_program);
        assert_eq!(ix.accounts.len(), 4);
        assert_eq!(ix.data[0], 12u8); // TransferChecked discriminator
        let amount = u64::from_le_bytes(ix.data[1..9].try_into().unwrap());
        assert_eq!(amount, 42_000);
        assert_eq!(ix.data[9], 6); // decimals

        // source writable, mint read-only, dest writable, authority signer
        assert!(ix.accounts[0].is_writable);
        assert!(!ix.accounts[1].is_writable);
        assert!(ix.accounts[2].is_writable);
        assert!(ix.accounts[3].is_signer);
    }

    // ── parse_challenge error cases ──

    #[test]
    fn parse_challenge_rejects_non_payment_scheme() {
        let err = parse_challenge("Bearer realm=\"test\"");
        assert!(err.is_err());
    }

    #[test]
    fn parse_challenge_rejects_missing_fields() {
        let err = parse_challenge("Payment id=\"abc\"");
        assert!(err.is_err());
    }
}
