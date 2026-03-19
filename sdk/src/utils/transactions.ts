import {
    type Base64EncodedWireTransaction,
    getBase64Codec,
    getBase64EncodedWireTransaction,
    getTransactionDecoder,
    partiallySignTransactionWithSigners,
    type TransactionPartialSigner,
} from '@solana/kit';

/**
 * Decode a base64 wire transaction, co-sign it with a TransactionPartialSigner,
 * and return the co-signed base64 wire transaction.
 *
 * Uses Kit's `partiallySignTransactionWithSigners` to handle signature merging
 * and validation. This bridges decoded wire transactions with the signer
 * interface (Keychain, Privy, Turnkey, AWS KMS, etc.).
 */
export async function coSignBase64Transaction(
    signer: TransactionPartialSigner,
    clientTxBase64: string,
): Promise<Base64EncodedWireTransaction> {
    const txBytes = getBase64Codec().encode(clientTxBase64);
    const tx = getTransactionDecoder().decode(txBytes);
    const cosigned = await partiallySignTransactionWithSigners([signer], tx);
    return getBase64EncodedWireTransaction(cosigned);
}
