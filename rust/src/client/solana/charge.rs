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
use crate::protocol::methods::solana::{programs, CredentialPayload, SolanaMethodDetails, Split};

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

    let mint = if currency != "sol" { Some(currency) } else { None };

    if let Some(mint_str) = mint {
        build_spl_instructions(
            &mut instructions,
            &signer_pubkey,
            &recipient_pubkey,
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

    // Add memo with reference.
    if !method_details.reference.is_empty() {
        let memo_data = format!("mppx:{}", method_details.reference);
        instructions.push(Instruction {
            program_id: Pubkey::from_str(programs::MEMO_PROGRAM)
                .map_err(|e| Error::Other(e.to_string()))?,
            accounts: vec![AccountMeta::new_readonly(signer_pubkey, true)],
            data: memo_data.into_bytes(),
        });
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
    spl: &str,
    method_details: &SolanaMethodDetails,
    primary_amount: u64,
    splits: &[Split],
    fee_payer: Option<&Pubkey>,
) -> Result<(), Error> {
    let mint =
        Pubkey::from_str(spl).map_err(|e| Error::Other(format!("Invalid mint: {e}")))?;
    let token_program = Pubkey::from_str(
        method_details
            .token_program
            .as_deref()
            .unwrap_or(programs::TOKEN_PROGRAM),
    )
    .map_err(|e| Error::Other(format!("Invalid token program: {e}")))?;
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
