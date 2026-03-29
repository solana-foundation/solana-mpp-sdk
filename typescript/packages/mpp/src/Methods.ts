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

const voucherSchema = z.object({
    /** Chain identifier, for example `solana:mainnet-beta`. */
    chainId: z.string(),
    /** Channel identifier bound to this voucher. */
    channelId: z.string(),
    /** Channel program address expected by server verifier. */
    channelProgram: z.string(),
    /** Monotonic cumulative authorized amount. */
    cumulativeAmount: z.string(),
    /** Optional voucher expiration timestamp in ISO-8601 format. */
    expiresAt: z.optional(z.string()),
    /** Meter name for priced usage tracking. */
    meter: z.string(),
    /** Wallet payer bound to this voucher. */
    payer: z.string(),
    /** Channel recipient service wallet. */
    recipient: z.string(),
    /** Monotonic sequence number for replay protection. */
    sequence: z.number(),
    /** Server-provided nonce for challenge binding. */
    serverNonce: z.string(),
    /** Meter units associated with this authorization update. */
    units: z.string(),
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
 * - **open**: opens a payment channel, records deposit, and anchors setup tx.
 * - **update**: submits a new monotonic voucher for cumulative usage.
 * - **topup**: increases channel escrow using a separate topup transaction.
 * - **close**: final voucher update used to finalize channel settlement.
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
                    /** Authorization mode selected by the authorizer implementation. */
                    authorizationMode: z.string(),
                    /** Optional advertised authorizer capabilities for client hints. */
                    capabilities: z.optional(
                        z.object({
                            /** Allowed action subset advertised by the authorizer. */
                            allowedActions: z.optional(z.array(z.string())),
                            /** Maximum cumulative authorized amount for this channel. */
                            maxCumulativeAmount: z.optional(z.string()),
                        }),
                    ),
                    /** Unique channel identifier generated by the client authorizer. */
                    channelId: z.string(),
                    /** Initial escrow amount committed for this channel. */
                    depositAmount: z.string(),
                    /** Optional voucher expiration timestamp in ISO-8601 format. */
                    expiresAt: z.optional(z.string()),
                    /** On-chain transaction reference proving open/setup step. */
                    openTx: z.string(),
                    /** Wallet payer for this channel (base58 public key). */
                    payer: z.string(),
                    /** Signed session voucher payload for open action. */
                    voucher: signedVoucherSchema,
                }),
                z.object({
                    /** Session lifecycle action. */
                    action: z.literal('update'),
                    /** Existing channel identifier targeted by this update. */
                    channelId: z.string(),
                    /** Signed session voucher payload for usage update. */
                    voucher: signedVoucherSchema,
                }),
                z.object({
                    /** Session lifecycle action. */
                    action: z.literal('topup'),
                    /** Additional escrow amount to add to channel deposit. */
                    additionalAmount: z.string(),
                    /** Existing channel identifier targeted by this topup. */
                    channelId: z.string(),
                    /** On-chain transaction reference proving topup execution. */
                    topupTx: z.string(),
                }),
                z.object({
                    /** Session lifecycle action. */
                    action: z.literal('close'),
                    /** Existing channel identifier targeted by this close. */
                    channelId: z.string(),
                    /** Optional on-chain settlement transaction reference for this close. */
                    closeTx: z.optional(z.string()),
                    /** Signed final voucher payload for close action. */
                    voucher: signedVoucherSchema,
                }),
            ]),
        },
        request: z.object({
            asset: z.object({
                /** Token decimals for amount normalization. */
                decimals: z.number(),
                /** Asset kind: native SOL or SPL token. */
                kind: z.string(),
                /** SPL mint address when kind is `spl`. */
                mint: z.optional(z.string()),
                /** Optional ticker/symbol used for display. */
                symbol: z.optional(z.string()),
            }),
            /** Channel program address used to verify vouchers and actions. */
            channelProgram: z.string(),
            /** Solana network name, for example mainnet-beta, devnet, localnet. */
            network: z.optional(z.string()),
            /** Optional pricing contract used to derive debit increments. */
            pricing: z.optional(
                z.object({
                    /** Price per unit in asset base units. */
                    amountPerUnit: z.string(),
                    /** Meter identifier for usage accounting. */
                    meter: z.string(),
                    /** Optional minimum debit to apply per request. */
                    minDebit: z.optional(z.string()),
                    /** Logical unit name charged by the service. */
                    unit: z.string(),
                }),
            ),
            /** Service recipient wallet that receives settlement funds. */
            recipient: z.string(),
            /** Optional server hints for default session behavior. */
            sessionDefaults: z.optional(
                z.object({
                    /** Optional close behavior hint for client UX. */
                    closeBehavior: z.optional(z.string()),
                    /** Optional settlement cadence policy hints. */
                    settleInterval: z.optional(
                        z.object({
                            kind: z.string(),
                            minIncrement: z.optional(z.string()),
                            seconds: z.optional(z.number()),
                        }),
                    ),
                    /** Suggested channel deposit to use on auto-open. */
                    suggestedDeposit: z.optional(z.string()),
                    /** Suggested time-to-live for channel/session in seconds. */
                    ttlSeconds: z.optional(z.number()),
                }),
            ),
            /** Optional server-side verifier policy hints. */
            verifier: z.optional(
                z.object({
                    /** Supported authorization modes for this endpoint. */
                    acceptAuthorizationModes: z.optional(z.array(z.string())),
                    /** Maximum allowable client/server clock skew in seconds. */
                    maxClockSkewSeconds: z.optional(z.number()),
                }),
            ),
        }),
    },
});
