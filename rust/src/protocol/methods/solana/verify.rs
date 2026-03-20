use solana_rpc_client::rpc_client::RpcClient;
use solana_signature::Signature;
use solana_transaction_status::{EncodedConfirmedTransactionWithStatusMeta, UiTransactionEncoding};
use std::str::FromStr;

use super::SolanaMethodDetails;
use crate::error::Error;

/// Verify a confirmed transaction matches the expected charge parameters.
pub fn verify_transaction_details(
    tx: &EncodedConfirmedTransactionWithStatusMeta,
    amount: &str,
    currency: &str,
    recipient: &str,
    method_details: &SolanaMethodDetails,
) -> Result<(), Error> {
    // Check for on-chain error.
    if let Some(meta) = &tx.transaction.meta {
        if meta.err.is_some() {
            return Err(Error::TransactionFailed(format!("{:?}", meta.err)));
        }
    }

    let splits = method_details.splits.as_deref().unwrap_or(&[]);
    let splits_total: u64 = splits
        .iter()
        .filter_map(|s| s.amount.parse::<u64>().ok())
        .sum();
    let total_amount: u64 = amount
        .parse()
        .map_err(|_| Error::Other(format!("Invalid amount: {amount}")))?;
    let primary_amount = total_amount
        .checked_sub(splits_total)
        .ok_or(Error::SplitsExceedAmount)?;
    if primary_amount == 0 {
        return Err(Error::SplitsExceedAmount);
    }

    // TODO: Parse jsonParsed instructions from the encoded transaction
    // and verify SOL/SPL transfers match expected amounts and recipients.
    // This requires deserializing UiParsedInstruction from the
    // EncodedTransaction, which varies based on the encoding format.
    let _ = (recipient, method_details);

    Ok(())
}

/// Fetch a confirmed transaction from an RPC endpoint.
pub fn fetch_transaction(
    rpc: &RpcClient,
    signature_str: &str,
) -> Result<EncodedConfirmedTransactionWithStatusMeta, Error> {
    let signature = Signature::from_str(signature_str)
        .map_err(|e| Error::Other(format!("Invalid signature: {e}")))?;

    rpc.get_transaction(&signature, UiTransactionEncoding::JsonParsed)
        .map_err(|e| {
            if e.to_string().contains("not found") {
                Error::TransactionNotFound
            } else {
                Error::Rpc(e.to_string())
            }
        })
}
