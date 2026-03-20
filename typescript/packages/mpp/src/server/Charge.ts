import { address, isTransactionPartialSigner, type TransactionPartialSigner } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { Method, Receipt, Store } from 'mppx';

import { DEFAULT_RPC_URLS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../constants.js';
import * as Methods from '../Methods.js';
import { coSignBase64Transaction } from '../utils/transactions.js';

/**
 * Creates a Solana `charge` method for usage on the server.
 *
 * Supports two settlement modes:
 *
 * - **Pull mode** (`type="transaction"`, default): The server receives a
 *   signed transaction from the client, broadcasts it to Solana, confirms
 *   it, and verifies the transfer on-chain. When `signer` is provided,
 *   the server co-signs as fee payer before broadcasting.
 *
 * - **Push mode** (`type="signature"`): The client has already broadcast
 *   and confirmed the transaction. The server verifies the transfer
 *   on-chain using the signature.
 *
 * @example
 * ```ts
 * import { Mppx, solana } from 'solana-mpp-sdk/server'
 *
 * const mppx = Mppx.create({
 *   methods: [solana.charge({
 *     recipient: 'RecipientPubkey...',
 *     spl: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
 *     decimals: 6,
 *     network: 'devnet',
 *   })],
 * })
 *
 * export async function handler(request: Request) {
 *   const result = await mppx.charge({ amount: '1000000', currency: 'USDC' })(request)
 *   if (result.status === 402) return result.challenge
 *   return result.withReceipt(Response.json({ data: '...' }))
 * }
 * ```
 */
export function charge(parameters: charge.Parameters) {
    const {
        recipient,
        currency,
        decimals,
        tokenProgram = TOKEN_PROGRAM,
        network = 'mainnet-beta',
        store = Store.memory(),
        splits,
        signer,
    } = parameters;

    const isSplToken = currency !== undefined && currency !== 'sol';

    const rpcUrl = parameters.rpcUrl ?? DEFAULT_RPC_URLS[network] ?? DEFAULT_RPC_URLS['mainnet-beta'];

    if (isSplToken && decimals === undefined) {
        throw new Error('decimals is required when currency is a token mint address');
    }

    if (splits && splits.length > 8) {
        throw new Error('splits cannot exceed 8 entries');
    }

    if (signer && !isTransactionPartialSigner(signer)) {
        throw new Error(
            'signer must implement signTransactions() for fee payer mode (e.g. KeyPairSigner, SolanaSigner)',
        );
    }

    return Method.toServer(Methods.charge, {
        defaults: {
            currency: currency ?? 'sol',
            methodDetails: {
                reference: '',
            },
            recipient: '',
        },

        async request({ credential, request }) {
            if (credential) {
                return credential.challenge.request as typeof request;
            }

            const reference = crypto.randomUUID();

            // Pre-fetch a recent blockhash so the client can skip an RPC call.
            let recentBlockhash: string | undefined;
            try {
                const res = await fetch(rpcUrl, {
                    body: JSON.stringify({
                        id: 1,
                        jsonrpc: '2.0',
                        method: 'getLatestBlockhash',
                        params: [{ commitment: 'confirmed' }],
                    }),
                    headers: { 'Content-Type': 'application/json' },
                    method: 'POST',
                });
                const data = (await res.json()) as { result?: { value?: { blockhash?: string } } };
                recentBlockhash = data.result?.value?.blockhash;
            } catch {
                // Non-fatal — client will fetch its own blockhash.
            }

            return {
                ...request,
                methodDetails: {
                    network,
                    reference,
                    ...(isSplToken ? { decimals, tokenProgram } : {}),
                    ...(signer ? { feePayer: true, feePayerKey: signer.address } : {}),
                    ...(splits?.length ? { splits } : {}),
                    ...(recentBlockhash ? { recentBlockhash } : {}),
                },
                recipient,
            };
        },

        async verify({ credential }) {
            const cred = credential as unknown as CredentialPayload;
            const challenge = cred.challenge.request;
            const payloadType = resolvePayloadType(cred.payload);

            // Spec: type="signature" MUST NOT be used with feePayer: true
            if (payloadType === 'signature' && challenge.methodDetails.feePayer) {
                throw new Error('type="signature" credentials cannot be used with fee sponsorship (feePayer: true)');
            }

            if (payloadType === 'transaction') {
                return await verifyTransaction(cred, challenge, rpcUrl, recipient, store, signer);
            }

            return await verifySignature(cred, challenge, rpcUrl, recipient, store);
        },
    });
}

// ── Payload type resolution ──

function resolvePayloadType(payload: {
    signature?: string;
    transaction?: string;
    type?: string;
}): 'signature' | 'transaction' {
    if (payload.type === 'signature') return 'signature';
    if (payload.type === 'transaction') return 'transaction';
    throw new Error('Missing or invalid payload type: must be "transaction" or "signature"');
}

// ── Pull mode (type="transaction") ──

async function verifyTransaction(
    credential: CredentialPayload,
    challenge: ChallengeRequest,
    rpcUrl: string,
    recipient: string,
    store: Store.Store,
    signer?: TransactionPartialSigner,
) {
    const { transaction: clientTxBase64 } = credential.payload;
    if (!clientTxBase64) {
        throw new Error('Missing transaction data in credential payload');
    }

    let txToSend = clientTxBase64;

    // When the server has a fee payer signer, decode the client's partially-signed
    // transaction, add the fee payer signature, and re-encode.
    // NOTE: The fee payer covers all tx costs including ATA rent (~0.002 SOL).
    // Recipients can close ATAs to reclaim rent, forcing re-creation on the next
    // payment. Servers should verify ATA existence before signing or factor rent
    // into pricing to mitigate this drain vector.
    if (signer) {
        txToSend = await coSignBase64Transaction(signer, clientTxBase64);
    }

    // Simulate before broadcast to catch failures without wasting fees.
    await simulateTransaction(rpcUrl, txToSend);

    // Broadcast the (now fully-signed) transaction.
    const signature = await broadcastTransaction(rpcUrl, txToSend);

    // Wait for on-chain confirmation.
    await waitForConfirmation(rpcUrl, signature);

    // Verify the confirmed transaction matches the challenge.
    await verifyOnChain(rpcUrl, signature, challenge, recipient);

    // Mark consumed to prevent replay.
    await store.put(`solana-charge:consumed:${signature}`, true);

    return Receipt.from({
        method: 'solana',
        reference: signature,
        status: 'success',
        timestamp: new Date().toISOString(),
    });
}

// ── Push mode (type="signature") ──

async function verifySignature(
    credential: CredentialPayload,
    challenge: ChallengeRequest,
    rpcUrl: string,
    recipient: string,
    store: Store.Store,
) {
    const { signature } = credential.payload;
    if (!signature) {
        throw new Error('Missing signature in credential payload');
    }

    // Replay prevention: reject already-consumed transaction signatures.
    const consumedKey = `solana-charge:consumed:${signature}`;
    if (await store.get(consumedKey)) {
        throw new Error('Transaction signature already consumed');
    }

    // Fetch and verify the transaction on-chain.
    const tx = await fetchTransaction(rpcUrl, signature);
    if (!tx) throw new Error('Transaction not found or not yet confirmed');
    if (tx.meta?.err) throw new Error('Transaction failed on-chain');

    const instructions = tx.transaction.message.instructions;
    await verifyInstructions(instructions, challenge, recipient);

    // Mark consumed to prevent replay.
    await store.put(consumedKey, true);

    return Receipt.from({
        method: 'solana',
        reference: signature,
        status: 'success',
        timestamp: new Date().toISOString(),
    });
}

// ── Shared on-chain verification ──

async function verifyOnChain(rpcUrl: string, signature: string, challenge: ChallengeRequest, recipient: string) {
    const tx = await fetchTransaction(rpcUrl, signature);
    if (!tx) throw new Error('Transaction not found or not yet confirmed');
    if (tx.meta?.err) throw new Error('Transaction failed on-chain');

    const instructions = tx.transaction.message.instructions;
    await verifyInstructions(instructions, challenge, recipient);
}

async function verifyInstructions(instructions: ParsedInstruction[], challenge: ChallengeRequest, recipient: string) {
    const splits = challenge.methodDetails.splits ?? [];
    const splitsTotal = splits.reduce((sum, s) => sum + BigInt(s.amount), 0n);
    const primaryAmount = BigInt(challenge.amount) - splitsTotal;

    if (primaryAmount <= 0n) {
        throw new Error('Splits consume the entire amount — primary recipient must receive a positive amount');
    }

    const mint = challenge.currency !== 'sol' ? challenge.currency : undefined;

    if (mint) {
        // ── SPL token transfers verification ──
        const transfers = instructions.filter(
            ix =>
                ix.parsed?.type === 'transferChecked' &&
                (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM),
        );

        const expectedTokenProgram = challenge.methodDetails.tokenProgram || TOKEN_PROGRAM;

        // Verify primary transfer to recipient.
        await verifySplTransfer(transfers, recipient, String(primaryAmount), mint, expectedTokenProgram);

        // Verify each split transfer.
        for (const split of splits) {
            await verifySplTransfer(transfers, split.recipient, split.amount, mint, expectedTokenProgram);
        }
    } else {
        // ── Native SOL transfers verification ──
        const transfers = instructions.filter(ix => ix.parsed?.type === 'transfer' && ix.program === 'system');

        // Verify primary transfer to recipient.
        verifySolTransfer(transfers, recipient, String(primaryAmount));

        // Verify each split transfer.
        for (const split of splits) {
            verifySolTransfer(transfers, split.recipient, split.amount);
        }
    }
}

async function verifySplTransfer(
    transfers: ParsedInstruction[],
    recipientAddress: string,
    expectedAmount: string,
    spl: string,
    tokenProgram: string,
) {
    const [expectedAta] = await findAssociatedTokenPda({
        mint: address(spl),
        owner: address(recipientAddress),
        tokenProgram: address(tokenProgram),
    });

    const transfer = transfers.find(ix => {
        const info = ix.parsed!.info as { destination: string; mint: string; tokenAmount: { amount: string } };
        return info.destination === expectedAta && info.mint === spl;
    });

    if (!transfer) {
        throw new Error(`No TransferChecked instruction found for recipient ${recipientAddress}`);
    }

    const info = transfer.parsed!.info as { destination: string; mint: string; tokenAmount: { amount: string } };
    if (info.tokenAmount.amount !== expectedAmount) {
        throw new Error(
            `Amount mismatch for ${recipientAddress}: expected ${expectedAmount}, got ${info.tokenAmount.amount}`,
        );
    }
}

function verifySolTransfer(transfers: ParsedInstruction[], recipientAddress: string, expectedAmount: string) {
    const transfer = transfers.find(ix => {
        const info = ix.parsed!.info as { destination: string };
        return info.destination === recipientAddress;
    });

    if (!transfer) {
        throw new Error(`No system transfer instruction found for recipient ${recipientAddress}`);
    }

    const info = transfer.parsed!.info as { destination: string; lamports: number };
    if (String(info.lamports) !== expectedAmount) {
        throw new Error(
            `Amount mismatch for ${recipientAddress}: expected ${expectedAmount} lamports, got ${info.lamports}`,
        );
    }
}

// ── Types ──

/** Credential payload from the mppx framework. */
type CredentialPayload = {
    challenge: {
        id?: string;
        request: ChallengeRequest;
    };
    payload: {
        signature?: string;
        transaction?: string;
        type?: string;
    };
};

/** The request portion of a challenge, matching the Methods.ts schema. */
type ChallengeRequest = {
    amount: string;
    currency: string;
    methodDetails: {
        decimals?: number;
        feePayer?: boolean;
        feePayerKey?: string;
        network?: string;
        recentBlockhash?: string;
        reference: string;
        splits?: Array<{ amount: string; memo?: string; recipient: string }>;
        tokenProgram?: string;
    };
    recipient: string;
};

/** A parsed instruction from a jsonParsed transaction. */
type ParsedInstruction = {
    parsed?: {
        info: Record<string, unknown>;
        type: string;
    };
    program?: string;
    programId?: string;
};

/** A parsed transaction result from getTransaction RPC. */
type ParsedTransaction = {
    meta: { err: unknown } | null;
    transaction: {
        message: {
            instructions: ParsedInstruction[];
        };
    };
};

// ── RPC helpers ──

async function fetchTransaction(rpcUrl: string, signature: string): Promise<ParsedTransaction | null> {
    const response = await fetch(rpcUrl, {
        body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'getTransaction',
            params: [
                signature,
                {
                    commitment: 'confirmed',
                    encoding: 'jsonParsed',
                    maxSupportedTransactionVersion: 0,
                },
            ],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    const data = (await response.json()) as {
        error?: { message: string };
        result?: ParsedTransaction | null;
    };
    if (data.error) throw new Error(`RPC error: ${data.error.message}`);
    return data.result ?? null;
}

async function simulateTransaction(rpcUrl: string, base64Tx: string): Promise<void> {
    const response = await fetch(rpcUrl, {
        body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'simulateTransaction',
            params: [base64Tx, { commitment: 'confirmed', encoding: 'base64' }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    const data = (await response.json()) as {
        error?: { message: string };
        result?: { value?: { err: unknown; logs?: string[] } };
    };
    if (data.error) throw new Error(`RPC error: ${data.error.message}`);
    const simErr = data.result?.value?.err;
    if (simErr) {
        const logs = data.result?.value?.logs ?? [];
        console.error('[solana-mpp] Simulation failed:', JSON.stringify(simErr));
        for (const log of logs) console.error('[solana-mpp]', log);
        throw new Error(`Transaction simulation failed: ${JSON.stringify(simErr)}`);
    }
}

async function broadcastTransaction(rpcUrl: string, base64Tx: string): Promise<string> {
    const response = await fetch(rpcUrl, {
        body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'sendTransaction',
            params: [base64Tx, { encoding: 'base64', skipPreflight: false }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    const data = (await response.json()) as {
        error?: { message: string };
        result?: string;
    };
    if (data.error) throw new Error(`RPC error: ${data.error.message}`);
    if (!data.result) throw new Error('No signature returned from sendTransaction');
    return data.result;
}

async function waitForConfirmation(rpcUrl: string, signature: string, timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const response = await fetch(rpcUrl, {
            body: JSON.stringify({
                id: 1,
                jsonrpc: '2.0',
                method: 'getSignatureStatuses',
                params: [[signature]],
            }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        const data = (await response.json()) as {
            result?: {
                value: ({ confirmationStatus: string; err: unknown } | null)[];
            };
        };
        const status = data.result?.value?.[0];
        if (status) {
            if (status.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
            }
            if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                return;
            }
        }
        await new Promise(r => setTimeout(r, 2_000));
    }
    throw new Error('Transaction confirmation timeout');
}

export declare namespace charge {
    type Parameters = {
        /**
         * Currency identifier. "SOL" for native SOL, or a base58-encoded
         * SPL token mint address (e.g. USDC mint). Defaults to "SOL".
         */
        currency?: string;
        /** Token decimals (required when currency is a mint address). */
        decimals?: number;
        /** Solana network. Defaults to 'mainnet-beta'. */
        network?: 'devnet' | 'localnet' | 'mainnet-beta' | (string & {});
        /** Base58-encoded recipient public key that receives payments. */
        recipient: string;
        /** Custom RPC URL. Defaults to public RPC for the selected network. */
        rpcUrl?: string;
        /**
         * Server-side signer for fee sponsorship (feePayer mode).
         * When provided, the server's public key is included in the challenge
         * as `feePayerKey`, and the server co-signs the transaction as fee payer
         * before broadcasting.
         *
         * Accepts any TransactionPartialSigner — KeyPairSigner, Keychain SolanaSigner, etc.
         */
        signer?: TransactionPartialSigner;
        /** Additional payment splits. Same asset as primary payment. Max 8 entries. */
        splits?: Array<{
            /** Amount in base units (same asset as primary). */
            amount: string;
            /** Optional memo (max 566 bytes). */
            memo?: string;
            /** Base58-encoded recipient of this split. */
            recipient: string;
        }>;
        /**
         * Pluggable key-value store for consumed-signature tracking (replay prevention).
         * Defaults to in-memory. Use a persistent store in production.
         */
        store?: Store.Store;
        /** Token program address. Defaults to TOKEN_PROGRAM. Set to TOKEN_2022_PROGRAM for Token-2022 mints. */
        tokenProgram?: string;
    };
}
