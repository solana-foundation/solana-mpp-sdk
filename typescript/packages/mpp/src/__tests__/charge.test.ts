/**
 * Tests for the server charge verification logic.
 *
 * Covers both settlement modes:
 * - Push mode (type="signature"): server fetches + verifies on-chain
 * - Pull mode (type="transaction"): server broadcasts, confirms, then verifies on-chain
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { Store } from 'mppx/server';
import { findAssociatedTokenPda } from '@solana-program/token';
import { address } from '@solana/kit';
import { charge } from '../server/Charge.js';
import { TOKEN_PROGRAM } from '../constants.js';

// ── Fixtures ──

const RECIPIENT = '9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIGNATURE = '5UfDuX6nSqMzMR8W7n6K3b1GKLmaqEisBFCcYPRLjNHrCbVQJF3BVjkE7aQJMQ2Kx';
const FAKE_TX_BASE64 = 'AQAAAA...'; // Placeholder base64-encoded signed tx

/** Build a push mode credential (type="signature"). */
function signatureCredential(
    sig: string,
    overrides: {
        amount?: string;
        currency?: string;
        recipient?: string;
        decimals?: number;
        tokenProgram?: string;
        splits?: Array<{ recipient: string; amount: string; memo?: string }>;
    } = {},
) {
    const curr = overrides.currency ?? 'sol';
    const isSpl = curr !== 'sol';
    return {
        payload: { type: 'signature', signature: sig },
        challenge: {
            request: {
                amount: overrides.amount ?? '1000000',
                currency: curr,
                recipient: overrides.recipient ?? RECIPIENT,
                methodDetails: {
                    network: 'devnet',
                    ...(isSpl
                        ? {
                              decimals: overrides.decimals ?? 6,
                              tokenProgram: overrides.tokenProgram ?? TOKEN_PROGRAM,
                          }
                        : {}),
                    ...(overrides.splits ? { splits: overrides.splits } : {}),
                },
            },
        },
    } as any;
}

/** Build a pull mode credential (type="transaction"). */
function transactionCredential(
    txBase64: string,
    overrides: {
        amount?: string;
        currency?: string;
        recipient?: string;
        decimals?: number;
        tokenProgram?: string;
    } = {},
) {
    const curr = overrides.currency ?? 'sol';
    const isSpl = curr !== 'sol';
    return {
        payload: { type: 'transaction', transaction: txBase64 },
        challenge: {
            request: {
                amount: overrides.amount ?? '1000000',
                currency: curr,
                recipient: overrides.recipient ?? RECIPIENT,
                methodDetails: {
                    network: 'devnet',
                    ...(isSpl
                        ? {
                              decimals: overrides.decimals ?? 6,
                              tokenProgram: overrides.tokenProgram ?? TOKEN_PROGRAM,
                          }
                        : {}),
                },
            },
        },
    } as any;
}

// ── RPC response builders ──

function rpcSuccess(result: unknown) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
        headers: { 'Content-Type': 'application/json' },
    });
}

function rpcError(message: string) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message } }), {
        headers: { 'Content-Type': 'application/json' },
    });
}

function solTransferTx(destination: string, lamports: number | string) {
    return {
        meta: { err: null },
        transaction: {
            message: {
                instructions: [
                    {
                        program: 'system',
                        parsed: {
                            type: 'transfer',
                            info: { destination, lamports: Number(lamports) },
                        },
                    },
                ],
            },
        },
    };
}

function splTransferTx(destination: string, mint: string, amount: string, programId: string = TOKEN_PROGRAM) {
    return {
        meta: { err: null },
        transaction: {
            message: {
                instructions: [
                    {
                        programId,
                        parsed: {
                            type: 'transferChecked',
                            info: {
                                destination,
                                mint,
                                tokenAmount: { amount },
                            },
                        },
                    },
                ],
            },
        },
    };
}

// ── Test setup ──

let originalFetch: typeof globalThis.fetch;
let store: Store.Store;

beforeEach(() => {
    originalFetch = globalThis.fetch;
    store = Store.memory();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

// ── Parameter validation ──

test('charge() throws when currency is a mint but decimals is missing', () => {
    expect(() =>
        charge({
            recipient: RECIPIENT,
            currency: USDC_MINT,
            // decimals intentionally omitted
            network: 'devnet',
            store,
        }),
    ).toThrow(/decimals is required/);
});

test('charge() does not throw for native SOL', () => {
    expect(() =>
        charge({
            recipient: RECIPIENT,
            network: 'devnet',
            store,
        }),
    ).not.toThrow();
});

// ── Request generation ──

test('request() populates fields without a request-side reference', async () => {
    // Mock fetch for the blockhash pre-fetch in request().
    globalThis.fetch = async () =>
        rpcSuccess({ value: { blockhash: 'MockBlockhash1111111111111111111111111111111', lastValidBlockHeight: 100 } });

    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        store,
    });

    const stub = {};

    const request1 = await method.request!({
        credential: null,
        request: { amount: '1000000', currency: USDC_MINT, recipient: '', methodDetails: stub },
    });

    expect(request1.recipient).toBe(RECIPIENT);
    expect(request1.methodDetails.network).toBe('devnet');
    expect(request1.methodDetails.decimals).toBe(6);
    expect(request1.methodDetails.recentBlockhash).toBeTruthy();
    expect(request1.methodDetails).not.toHaveProperty('reference');
});

test('request() returns the challenge request when credential is present', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        store,
    });

    const challengeRequest = {
        amount: '1000000',
        currency: 'sol',
        recipient: RECIPIENT,
        methodDetails: {
            network: 'devnet',
        },
    };

    const result = await method.request!({
        credential: { challenge: { request: challengeRequest } } as any,
        request: { amount: '1000000', currency: 'sol', recipient: '', methodDetails: {} },
    });

    expect(result).toEqual(challengeRequest);
});

// ══════════════════════════════════════════════════════════════════════
// Push mode (type="signature")
// ══════════════════════════════════════════════════════════════════════

// ── Native SOL verification ──

test('signature: accepts valid native SOL transfer', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    globalThis.fetch = async () => rpcSuccess(solTransferTx(RECIPIENT, 1000000));

    const receipt = await method.verify({
        credential: signatureCredential(SIGNATURE, { amount: '1000000' }),
        request: {} as any,
    });

    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe(SIGNATURE);
});

test('signature: rejects SOL transfer with wrong recipient', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    globalThis.fetch = async () => rpcSuccess(solTransferTx('WrongRecipient111111111111111111111', 1000000));

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000' }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No.*transfer.*instruction.*found|Recipient mismatch/);
});

test('signature: rejects SOL transfer with wrong amount', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    globalThis.fetch = async () => rpcSuccess(solTransferTx(RECIPIENT, 500000));

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000' }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No system transfer instruction found/);
});

// ── SPL token verification ──

test('signature: accepts valid SPL token transfer', async () => {
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    const [expectedAta] = await findAssociatedTokenPda({
        owner: address(RECIPIENT),
        mint: address(USDC_MINT),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    globalThis.fetch = async () => rpcSuccess(splTransferTx(expectedAta, USDC_MINT, '1000000'));

    const receipt = await method.verify({
        credential: signatureCredential(SIGNATURE, {
            amount: '1000000',
            currency: USDC_MINT,
            decimals: 6,
        }),
        request: {} as any,
    });

    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe(SIGNATURE);
});

test('signature: rejects SPL transfer with wrong mint', async () => {
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    const [expectedAta] = await findAssociatedTokenPda({
        owner: address(RECIPIENT),
        mint: address(USDC_MINT),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    const WRONG_MINT = 'So11111111111111111111111111111111111111112';
    globalThis.fetch = async () => rpcSuccess(splTransferTx(expectedAta, WRONG_MINT, '1000000'));

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, {
                amount: '1000000',
                currency: USDC_MINT,
                decimals: 6,
            }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No TransferChecked instruction found|Token mint mismatch/);
});

test('signature: rejects SPL transfer with wrong amount', async () => {
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    const [expectedAta] = await findAssociatedTokenPda({
        owner: address(RECIPIENT),
        mint: address(USDC_MINT),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    globalThis.fetch = async () => rpcSuccess(splTransferTx(expectedAta, USDC_MINT, '500000'));

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, {
                amount: '1000000',
                currency: USDC_MINT,
                decimals: 6,
            }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No TransferChecked instruction found/);
});

test('signature: rejects SPL transfer with wrong destination ATA', async () => {
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    const WRONG_ATA = 'WrongATA11111111111111111111111111111111111';
    globalThis.fetch = async () => rpcSuccess(splTransferTx(WRONG_ATA, USDC_MINT, '1000000'));

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, {
                amount: '1000000',
                currency: USDC_MINT,
                decimals: 6,
            }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No TransferChecked instruction found|Destination token account does not belong/);
});

// ── Replay prevention (type="signature") ──

test('signature: rejects already-consumed transaction signature', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    globalThis.fetch = async () => rpcSuccess(solTransferTx(RECIPIENT, 1000000));

    // First call succeeds
    await method.verify({
        credential: signatureCredential(SIGNATURE, { amount: '1000000' }),
        request: {} as any,
    });

    // Second call with same signature is rejected
    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000' }),
            request: {} as any,
        }),
    ).rejects.toThrow(/already consumed/);
});

// ── RPC error handling (type="signature") ──

test('signature: throws when transaction is not found', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    globalThis.fetch = async () => rpcSuccess(null);

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000' }),
            request: {} as any,
        }),
    ).rejects.toThrow(/Transaction not found/);
});

test('signature: throws when transaction failed on-chain', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: { InstructionError: [0, 'Custom'] } },
            transaction: { message: { instructions: [] } },
        });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000' }),
            request: {} as any,
        }),
    ).rejects.toThrow(/Transaction failed on-chain/);
});

test('signature: throws on RPC error response', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    globalThis.fetch = async () => rpcError('Transaction version not supported');

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000' }),
            request: {} as any,
        }),
    ).rejects.toThrow(/RPC error/);
});

test('signature: throws when no transfer instruction found (SOL)', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: { message: { instructions: [] } },
        });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000' }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No system transfer instruction found/);
});

test('signature: throws when no TransferChecked instruction found (SPL)', async () => {
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: { message: { instructions: [] } },
        });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, {
                amount: '1000000',
                currency: USDC_MINT,
                decimals: 6,
            }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No TransferChecked instruction found/);
});

// ══════════════════════════════════════════════════════════════════════
// Pull mode (type="transaction")
// ══════════════════════════════════════════════════════════════════════

/**
 * Helper to mock fetch for pull mode flow.
 * The server makes 3 sequential RPC calls:
 *   1. sendTransaction → returns signature
 *   2. getSignatureStatuses → returns confirmed
 *   3. getTransaction → returns parsed tx for verification
 */
function mockServerBroadcastFetch(txResult: unknown, signature: string = SIGNATURE) {
    globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const method = body.method;

        if (method === 'simulateTransaction') {
            return rpcSuccess({ value: { err: null, logs: [] } });
        }

        if (method === 'sendTransaction') {
            return rpcSuccess(signature);
        }

        if (method === 'getSignatureStatuses') {
            return rpcSuccess({
                value: [{ confirmationStatus: 'confirmed', err: null }],
            });
        }

        if (method === 'getTransaction') {
            return rpcSuccess(txResult);
        }

        throw new Error(`Unexpected RPC method: ${method}`);
    };
}

test('pull: accepts valid native SOL transfer', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    mockServerBroadcastFetch(solTransferTx(RECIPIENT, 1000000));

    const receipt = await method.verify({
        credential: transactionCredential(FAKE_TX_BASE64, { amount: '1000000' }),
        request: {} as any,
    });

    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe(SIGNATURE);
});

test('pull: accepts valid SPL token transfer', async () => {
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    const [expectedAta] = await findAssociatedTokenPda({
        owner: address(RECIPIENT),
        mint: address(USDC_MINT),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    mockServerBroadcastFetch(splTransferTx(expectedAta, USDC_MINT, '1000000'));

    const receipt = await method.verify({
        credential: transactionCredential(FAKE_TX_BASE64, {
            amount: '1000000',
            currency: USDC_MINT,
            decimals: 6,
        }),
        request: {} as any,
    });

    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe(SIGNATURE);
});

test('transaction: rejects when sendTransaction fails', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    globalThis.fetch = async () => rpcError('Transaction simulation failed');

    await expect(
        method.verify({
            credential: transactionCredential(FAKE_TX_BASE64, { amount: '1000000' }),
            request: {} as any,
        }),
    ).rejects.toThrow(/RPC error/);
});

test('transaction: rejects when on-chain verification fails (wrong recipient)', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    mockServerBroadcastFetch(solTransferTx('WrongRecipient111111111111111111111', 1000000));

    await expect(
        method.verify({
            credential: transactionCredential(FAKE_TX_BASE64, { amount: '1000000' }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No.*transfer.*instruction.*found|Recipient mismatch/);
});

test('transaction: throws when transaction data is missing', async () => {
    const method = charge({
        recipient: RECIPIENT,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
    });

    await expect(
        method.verify({
            credential: {
                payload: { type: 'transaction' },
                challenge: {
                    request: {
                        amount: '1000000',
                        currency: 'sol',
                        recipient: RECIPIENT,
                        methodDetails: {
                            network: 'devnet',
                        },
                    },
                },
            } as any,
            request: {} as any,
        }),
    ).rejects.toThrow(/Missing transaction data/);
});

// ══════════════════════════════════════════════════════════════════════
// Splits
// ══════════════════════════════════════════════════════════════════════

const PLATFORM = '3pF8Kg2aHbNvJkLMwEqR7YtDxZ5sGhJn4UV6mWcXrT9A';

test('splits: charge() rejects more than 8 splits', () => {
    const splits = Array.from({ length: 9 }, () => ({
        recipient: PLATFORM,
        amount: '1000',
    }));
    expect(() => charge({ recipient: RECIPIENT, network: 'devnet', store, splits })).toThrow(/exceed 8/);
});

test('splits: request() includes splits in challenge', async () => {
    globalThis.fetch = async () =>
        rpcSuccess({
            value: { blockhash: 'MockBlockhash1111111111111111111111111111111', lastValidBlockHeight: 100 },
        });

    const splits = [{ recipient: PLATFORM, amount: '50000', memo: 'platform fee' }];
    const method = charge({ recipient: RECIPIENT, network: 'devnet', store, splits });

    const request = await method.request!({
        credential: null,
        request: { amount: '1050000', currency: 'sol', recipient: '', methodDetails: {} },
    });

    expect(request.methodDetails.splits).toBeTruthy();
    expect(request.methodDetails.splits!.length).toBe(1);
    expect(request.methodDetails.splits![0].recipient).toBe(PLATFORM);
    expect(request.methodDetails.splits![0].amount).toBe('50000');
    expect(request.methodDetails.splits![0].memo).toBe('platform fee');
});

test('splits: SOL verification passes with valid primary + split transfers', async () => {
    const splits = [{ recipient: PLATFORM, amount: '50000' }];
    const method = charge({ recipient: RECIPIENT, network: 'devnet', rpcUrl: 'https://mock-rpc', store, splits });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: RECIPIENT, lamports: 950000 } },
                        },
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: PLATFORM, lamports: 50000 } },
                        },
                    ],
                },
            },
        });

    const receipt = await method.verify({
        credential: signatureCredential(SIGNATURE, { amount: '1000000', splits }),
        request: {} as any,
    });

    expect(receipt.status).toBe('success');
});

test('splits: SOL verification fails when split transfer missing', async () => {
    const splits = [{ recipient: PLATFORM, amount: '50000' }];
    const method = charge({ recipient: RECIPIENT, network: 'devnet', rpcUrl: 'https://mock-rpc', store, splits });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: RECIPIENT, lamports: 950000 } },
                        },
                    ],
                },
            },
        });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000', splits }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No.*transfer.*instruction.*found.*3pF8/);
});

test('splits: SOL verification fails when split amount is wrong', async () => {
    const splits = [{ recipient: PLATFORM, amount: '50000' }];
    const method = charge({ recipient: RECIPIENT, network: 'devnet', rpcUrl: 'https://mock-rpc', store, splits });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: RECIPIENT, lamports: 950000 } },
                        },
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: PLATFORM, lamports: 25000 } },
                        },
                    ],
                },
            },
        });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000', splits }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No system transfer instruction found.*3pF8/);
});

test('splits: SOL verification matches distinct same-recipient transfers by amount', async () => {
    const duplicateRecipient = PLATFORM;
    const splits = [{ recipient: duplicateRecipient, amount: '50000' }];
    const method = charge({ recipient: duplicateRecipient, network: 'devnet', rpcUrl: 'https://mock-rpc', store, splits });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: duplicateRecipient, lamports: 950000 } },
                        },
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: duplicateRecipient, lamports: 50000 } },
                        },
                    ],
                },
            },
        });

    const receipt = await method.verify({
        credential: signatureCredential(SIGNATURE, { amount: '1000000', recipient: duplicateRecipient, splits }),
        request: {} as any,
    });

    expect(receipt.status).toBe('success');
});

test('splits: rejects splits that consume entire amount', async () => {
    const splits = [{ recipient: PLATFORM, amount: '1000000' }];
    const method = charge({ recipient: RECIPIENT, network: 'devnet', rpcUrl: 'https://mock-rpc', store, splits });

    globalThis.fetch = async () => rpcSuccess({ meta: { err: null }, transaction: { message: { instructions: [] } } });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000', splits }),
            request: {} as any,
        }),
    ).rejects.toThrow(/primary recipient must receive a positive amount/);
});

test('splits: rejects splits that exceed total amount', async () => {
    const splits = [{ recipient: PLATFORM, amount: '2000000' }];
    const method = charge({ recipient: RECIPIENT, network: 'devnet', rpcUrl: 'https://mock-rpc', store, splits });

    globalThis.fetch = async () => rpcSuccess({ meta: { err: null }, transaction: { message: { instructions: [] } } });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000', splits }),
            request: {} as any,
        }),
    ).rejects.toThrow(/primary recipient must receive a positive amount/);
});

test('splits: SPL verification passes with valid primary + split transfers', async () => {
    const splits = [{ recipient: PLATFORM, amount: '50000' }];
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
        splits,
    });

    const [recipientAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(RECIPIENT),
        tokenProgram: address(TOKEN_PROGRAM),
    });
    const [platformAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(PLATFORM),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: recipientAta, mint: USDC_MINT, tokenAmount: { amount: '950000' } },
                            },
                        },
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: platformAta, mint: USDC_MINT, tokenAmount: { amount: '50000' } },
                            },
                        },
                    ],
                },
            },
        });

    const receipt = await method.verify({
        credential: signatureCredential(SIGNATURE, { amount: '1000000', currency: USDC_MINT, decimals: 6, splits }),
        request: {} as any,
    });

    expect(receipt.status).toBe('success');
});

test('splits: SPL verification fails when split transfer is missing', async () => {
    const splits = [{ recipient: PLATFORM, amount: '50000' }];
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
        splits,
    });

    const [recipientAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(RECIPIENT),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: recipientAta, mint: USDC_MINT, tokenAmount: { amount: '950000' } },
                            },
                        },
                    ],
                },
            },
        });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000', currency: USDC_MINT, decimals: 6, splits }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No TransferChecked instruction found.*3pF8/);
});

test('splits: SPL verification fails when primary amount is wrong', async () => {
    const splits = [{ recipient: PLATFORM, amount: '50000' }];
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
        splits,
    });

    const [recipientAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(RECIPIENT),
        tokenProgram: address(TOKEN_PROGRAM),
    });
    const [platformAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(PLATFORM),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: {
                                    destination: recipientAta,
                                    mint: USDC_MINT,
                                    tokenAmount: { amount: '1000000' },
                                },
                            },
                        },
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: platformAta, mint: USDC_MINT, tokenAmount: { amount: '50000' } },
                            },
                        },
                    ],
                },
            },
        });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000', currency: USDC_MINT, decimals: 6, splits }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No TransferChecked instruction found.*9xAX/);
});

test('splits: SPL verification fails when split amount is wrong', async () => {
    const splits = [{ recipient: PLATFORM, amount: '50000' }];
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
        splits,
    });

    const [recipientAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(RECIPIENT),
        tokenProgram: address(TOKEN_PROGRAM),
    });
    const [platformAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(PLATFORM),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: recipientAta, mint: USDC_MINT, tokenAmount: { amount: '950000' } },
                            },
                        },
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: platformAta, mint: USDC_MINT, tokenAmount: { amount: '25000' } },
                            },
                        },
                    ],
                },
            },
        });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000', currency: USDC_MINT, decimals: 6, splits }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No TransferChecked instruction found.*3pF8/);
});

test('splits: SPL verification matches distinct same-recipient transfers by amount', async () => {
    const duplicateRecipient = PLATFORM;
    const splits = [{ recipient: duplicateRecipient, amount: '50000' }];
    const method = charge({
        recipient: duplicateRecipient,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
        splits,
    });

    const [duplicateAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(duplicateRecipient),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: duplicateAta, mint: USDC_MINT, tokenAmount: { amount: '950000' } },
                            },
                        },
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: duplicateAta, mint: USDC_MINT, tokenAmount: { amount: '50000' } },
                            },
                        },
                    ],
                },
            },
        });

    const receipt = await method.verify({
        credential: signatureCredential(SIGNATURE, {
            amount: '1000000',
            currency: USDC_MINT,
            recipient: duplicateRecipient,
            decimals: 6,
            splits,
        }),
        request: {} as any,
    });

    expect(receipt.status).toBe('success');
});

test('splits: multiple splits with SPL', async () => {
    const REFERRER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const splits = [
        { recipient: PLATFORM, amount: '30000' },
        { recipient: REFERRER, amount: '20000' },
    ];
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
        splits,
    });

    const [recipientAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(RECIPIENT),
        tokenProgram: address(TOKEN_PROGRAM),
    });
    const [platformAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(PLATFORM),
        tokenProgram: address(TOKEN_PROGRAM),
    });
    const [referrerAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(REFERRER),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: recipientAta, mint: USDC_MINT, tokenAmount: { amount: '950000' } },
                            },
                        },
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: platformAta, mint: USDC_MINT, tokenAmount: { amount: '30000' } },
                            },
                        },
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: referrerAta, mint: USDC_MINT, tokenAmount: { amount: '20000' } },
                            },
                        },
                    ],
                },
            },
        });

    const receipt = await method.verify({
        credential: signatureCredential(SIGNATURE, { amount: '1000000', currency: USDC_MINT, decimals: 6, splits }),
        request: {} as any,
    });

    expect(receipt.status).toBe('success');
});

test('splits: duplicate SOL recipients require distinct transfer instructions', async () => {
    const splits = [
        { recipient: PLATFORM, amount: '30000' },
        { recipient: PLATFORM, amount: '20000' },
    ];
    const method = charge({ recipient: RECIPIENT, network: 'devnet', rpcUrl: 'https://mock-rpc', store, splits });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: RECIPIENT, lamports: 950000 } },
                        },
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: PLATFORM, lamports: 30000 } },
                        },
                    ],
                },
            },
        });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000', splits }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No system transfer instruction found.*3pF8/);
});

test('splits: duplicate SPL recipients require distinct transfer instructions', async () => {
    const splits = [
        { recipient: PLATFORM, amount: '30000' },
        { recipient: PLATFORM, amount: '20000' },
    ];
    const method = charge({
        recipient: RECIPIENT,
        currency: USDC_MINT,
        decimals: 6,
        network: 'devnet',
        rpcUrl: 'https://mock-rpc',
        store,
        splits,
    });

    const [recipientAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(RECIPIENT),
        tokenProgram: address(TOKEN_PROGRAM),
    });
    const [platformAta] = await findAssociatedTokenPda({
        mint: address(USDC_MINT),
        owner: address(PLATFORM),
        tokenProgram: address(TOKEN_PROGRAM),
    });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: recipientAta, mint: USDC_MINT, tokenAmount: { amount: '950000' } },
                            },
                        },
                        {
                            programId: TOKEN_PROGRAM,
                            parsed: {
                                type: 'transferChecked',
                                info: { destination: platformAta, mint: USDC_MINT, tokenAmount: { amount: '30000' } },
                            },
                        },
                    ],
                },
            },
        });

    await expect(
        method.verify({
            credential: signatureCredential(SIGNATURE, { amount: '1000000', currency: USDC_MINT, decimals: 6, splits }),
            request: {} as any,
        }),
    ).rejects.toThrow(/No TransferChecked instruction found.*3pF8/);
});

test('splits: multiple splits with SOL', async () => {
    const REFERRER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const splits = [
        { recipient: PLATFORM, amount: '30000' },
        { recipient: REFERRER, amount: '20000' },
    ];
    const method = charge({ recipient: RECIPIENT, network: 'devnet', rpcUrl: 'https://mock-rpc', store, splits });

    globalThis.fetch = async () =>
        rpcSuccess({
            meta: { err: null },
            transaction: {
                message: {
                    instructions: [
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: RECIPIENT, lamports: 950000 } },
                        },
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: PLATFORM, lamports: 30000 } },
                        },
                        {
                            program: 'system',
                            parsed: { type: 'transfer', info: { destination: REFERRER, lamports: 20000 } },
                        },
                    ],
                },
            },
        });

    const receipt = await method.verify({
        credential: signatureCredential(SIGNATURE, { amount: '1000000', splits }),
        request: {} as any,
    });

    expect(receipt.status).toBe('success');
});
