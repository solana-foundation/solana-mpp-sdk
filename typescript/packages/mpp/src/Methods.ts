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
            /** Identifies the unit for amount. "SOL" for native, or token symbol/mint (e.g. "USDC"). */
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

const voucherSchema = z.object({
    /** Channel PDA address. Cryptographically commits to payer, payee, token, and program via derivation. */
    channelId: z.string(),
    /** Monotonic cumulative authorized amount in token base units. */
    cumulativeAmount: z.string(),
    /** Optional voucher expiration timestamp in ISO-8601 format. */
    expiresAt: z.optional(z.string()),
});

const signedVoucherSchema = z.object({
    /** Base58/encoded signature over canonical voucher bytes. */
    signature: z.string(),
    /** Signature scheme discriminator (`ed25519` or `swig-session`). */
    signatureType: z.string(),
    /** Voucher signer public key. */
    signer: z.string(),
    voucher: voucherSchema,
});

/**
 * Solana session method shared schema used by both server and client.
 *
 * Supports four credential actions:
 *
 * - **open**: opens a payment channel via a partially-signed transaction (pull mode).
 * - **voucher**: submits a new monotonic voucher authorizing cumulative spend.
 * - **topUp**: increases channel escrow via a partially-signed transaction.
 * - **close**: cooperative channel close with optional final voucher.
 */
export const session = Method.from({
    intent: 'session',
    name: 'solana',
    schema: {
        credential: {
            payload: z.discriminatedUnion('action', [
                z.object({
                    /** Session lifecycle action. */
                    action: z.literal('open'),
                    /** Voucher signer policy for delegated signing. */
                    authorizationPolicy: z.optional(z.record(z.string(), z.unknown())),
                    /** Implementation-specific extensions. */
                    capabilities: z.optional(z.record(z.string(), z.unknown())),
                    /** Channel PDA address (derived from payer, payee, token, salt, authorizedSigner, channelProgram). */
                    channelId: z.string(),
                    /** Initial escrow amount committed for this channel. */
                    depositAmount: z.string(),
                    /** Session expiration (ISO 8601). */
                    expiresAt: z.optional(z.string()),
                    /** Wallet payer for this channel (base58 public key). */
                    payer: z.string(),
                    /** Base64-encoded partially-signed transaction (pull mode). Server co-signs and broadcasts. */
                    transaction: z.string(),
                    /** Signed session voucher for the initial authorization. */
                    voucher: signedVoucherSchema,
                }),
                z.object({
                    /** Session lifecycle action. */
                    action: z.literal('voucher'),
                    /** Channel PDA address targeted by this voucher. */
                    channelId: z.string(),
                    /** Signed session voucher authorizing cumulative spend. */
                    voucher: signedVoucherSchema,
                }),
                z.object({
                    /** Session lifecycle action. */
                    action: z.literal('topUp'),
                    /** Additional escrow amount to add to channel deposit. */
                    additionalAmount: z.string(),
                    /** Channel PDA address targeted by this top-up. */
                    channelId: z.string(),
                    /** Base64-encoded partially-signed transaction (pull mode). Server co-signs and broadcasts. */
                    transaction: z.string(),
                }),
                z.object({
                    /** Session lifecycle action. */
                    action: z.literal('close'),
                    /** Channel PDA address targeted by this close. */
                    channelId: z.string(),
                    /** Signed final voucher. Optional if highest amount is already settled on-chain. */
                    voucher: z.optional(signedVoucherSchema),
                }),
            ]),
        },
        request: z.object({
            /** Price per unit in token base units. */
            amount: z.string(),
            /** Currency identifier: "sol" for native SOL, or SPL mint address. */
            currency: z.string(),
            /** Human-readable description of the resource or service. */
            description: z.optional(z.string()),
            /** Merchant's reference for reconciliation. */
            externalId: z.optional(z.string()),
            methodDetails: z.object({
                /** Existing channel PDA to resume (if reconnecting to an open channel). */
                channelId: z.optional(z.string()),

                /** Channel program address for voucher verification. */
                channelProgram: z.string(),
                /** Token decimals (required for SPL tokens). */
                decimals: z.optional(z.number()),
                /** If true, server pays transaction fees. Client must use feePayerKey. */
                feePayer: z.optional(z.boolean()),
                /** Server's base58-encoded public key for fee payment. Present when feePayer is true. */
                feePayerKey: z.optional(z.string()),
                /** Grace period in seconds for forced close (recommended 900). */
                gracePeriodSeconds: z.optional(z.number()),
                /** Minimum voucher delta the server will accept. */
                minVoucherDelta: z.optional(z.string()),
                /** Solana network: mainnet-beta, devnet, or localnet. */
                network: z.optional(z.string()),
                /** Token program address (TOKEN_PROGRAM or TOKEN_2022_PROGRAM). */
                tokenProgram: z.optional(z.string()),
                /** Suggested time-to-live for the session in seconds. */
                ttlSeconds: z.optional(z.number()),
            }),
            /** Base58-encoded recipient (payee) public key. */
            recipient: z.string(),
            /** Suggested initial channel deposit in token base units. */
            suggestedDeposit: z.optional(z.string()),
            /** Unit type for pricing (e.g., "request", "token", "byte"). */
            unitType: z.optional(z.string()),
        }),
    },
});
