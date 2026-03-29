import { Method, z } from 'mppx';

/**
 * Solana charge method — shared schema used by both server and client.
 *
 * Supports two settlement modes:
 *
 * - **Pull mode** (`type="transaction"`, default): Client signs the
 *   transaction and sends the bytes to the server. The server broadcasts,
 *   confirms, and verifies the transfer on-chain.
 *
 * - **Push mode** (`type="signature"`): Client broadcasts the transaction
 *   itself and sends the confirmed signature. The server verifies on-chain.
 */
export const charge = Method.from({
    intent: 'charge',
    name: 'solana',
    schema: {
        credential: {
            payload: z.object({
                /** Base58-encoded transaction signature (when type="signature"). */
                signature: z.optional(z.string()),
                /** Base64-encoded serialized signed transaction (when type="transaction"). */
                transaction: z.optional(z.string()),
                /** Payload type: "transaction" (server broadcasts) or "signature" (client already broadcast). */
                type: z.string(),
            }),
        },
        request: z.object({
            /** Amount in smallest unit (lamports for SOL, base units for SPL tokens). */
            amount: z.string(),
            /** Identifies the unit for amount. "sol" (lowercase) for native SOL, or the token mint address for SPL tokens. */
            currency: z.string(),
            /** Human-readable memo describing the resource or service being paid for. */
            description: z.optional(z.string()),
            /** Merchant's reference (e.g., order ID, invoice number) for reconciliation. */
            externalId: z.optional(z.string()),
            methodDetails: z.object({
                /** Token decimals (required for SPL token transfers). */
                decimals: z.optional(z.number()),
                /** If true, server pays transaction fees. Client must use the server's feePayerKey. */
                feePayer: z.optional(z.boolean()),
                /** Server's base58-encoded public key for fee payment. Present when feePayer is true. */
                feePayerKey: z.optional(z.string()),
                /** Solana network: mainnet-beta, devnet, or localnet. */
                network: z.optional(z.string()),
                /** Server-provided base58-encoded recent blockhash. Saves the client an RPC round-trip. */
                recentBlockhash: z.optional(z.string()),
                /** Additional payment splits (max 32). Same asset as primary payment. */
                splits: z.optional(
                    z.array(
                        z.object({
                            /** Amount in base units (same asset as primary). */
                            amount: z.string(),
                            /** Optional memo for this split (max 566 bytes). */
                            memo: z.optional(z.string()),
                            /** Base58-encoded recipient of this split. */
                            recipient: z.string(),
                        }),
                    ),
                ),
                /** Token program address (TOKEN_PROGRAM or TOKEN_2022_PROGRAM). Defaults to TOKEN_PROGRAM. */
                tokenProgram: z.optional(z.string()),
            }),
            /** Base58-encoded recipient public key. */
            recipient: z.string(),
        }),
    },
});
