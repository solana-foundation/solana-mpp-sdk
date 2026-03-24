import { getBase58Encoder } from '@solana/kit';
import type { TransactionPartialSigner } from '@solana/kit';

import { coSignBase64Transaction } from '../utils/transactions.js';
import { DISCRIMINATOR_OPEN, DISCRIMINATOR_TOP_UP } from './MppChannelClient.js';

/**
 * Create a TransactionHandler for session open and topUp operations.
 *
 * Follows the charge intent's pull-mode pattern:
 * 1. Optionally co-sign as fee payer
 * 2. Simulate to catch errors before broadcast
 * 3. Broadcast via sendTransaction
 * 4. Poll getSignatureStatuses for confirmation
 * 5. Semantically verify the confirmed transaction: discriminator, amounts, and key accounts
 * 6. Return the confirmed signature
 *
 * The semantic verification (step 5) checks that the confirmed transaction:
 * - Invokes the expected channel program
 * - Contains the correct Anchor discriminator (open or top_up, not an arbitrary instruction)
 * - Carries the correct deposit/amount as encoded in the Borsh instruction data
 * - Uses the expected payee and token mint (open only)
 *
 * Without these checks, a client could submit a transaction that merely touches
 * the program with different arguments, causing the server to track channel state
 * that diverges from on-chain reality.
 */
export function createSessionTransactionHandler(params: {
    channelProgram: string;
    /** Base58 payee public key. Used to verify the payee account in open transactions. */
    recipient: string;
    /** SPL token mint address, or 'sol' for native SOL (not yet supported on-chain). */
    currency: string;
    rpcUrl: string;
    signer?: TransactionPartialSigner;
}): {
    handleOpen: (channelId: string, transaction: string, deposit: string) => Promise<string>;
    handleTopUp: (channelId: string, transaction: string, amount: string) => Promise<string>;
} {
    const { channelProgram, recipient, currency, rpcUrl, signer } = params;

    async function processTransaction(clientTxBase64: string): Promise<string> {
        let txToSend = clientTxBase64;

        if (signer) {
            txToSend = await coSignBase64Transaction(signer, clientTxBase64);
        }

        await simulateTransaction(rpcUrl, txToSend);
        const signature = await broadcastTransaction(rpcUrl, txToSend);
        await waitForConfirmation(rpcUrl, signature);

        const tx = await fetchTransaction(rpcUrl, signature);
        if (!tx) {
            throw new Error(`Transaction not found after confirmation: ${signature}`);
        }
        if (tx.meta?.err) {
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`);
        }

        return signature;
    }

    return {
        async handleOpen(channelId, transaction, deposit) {
            const signature = await processTransaction(transaction);

            const tx = await fetchTransaction(rpcUrl, signature);
            if (!tx) throw new Error(`Open transaction not found: ${signature}`);

            verifyOpenInstruction(
                tx.transaction.message.instructions,
                channelProgram,
                recipient,
                currency,
                BigInt(deposit),
                channelId,
            );

            return signature;
        },
        async handleTopUp(channelId, transaction, amount) {
            const signature = await processTransaction(transaction);

            const tx = await fetchTransaction(rpcUrl, signature);
            if (!tx) throw new Error(`TopUp transaction not found: ${signature}`);

            verifyTopUpInstruction(tx.transaction.message.instructions, channelProgram, BigInt(amount), channelId);

            return signature;
        },
    };
}

// ---- Semantic instruction verification ----

/**
 * Verify that the transaction contains a valid mpp-channel `open` instruction.
 *
 * Checks:
 * - The channel program instruction has the `open` discriminator (not settle, topUp, etc.)
 * - The deposit encoded in instruction data matches the credential's depositAmount
 * - accounts[1] (payee) matches the server's configured recipient
 * - accounts[2] (mint) matches the server's configured currency, if it is an SPL mint address
 * - accounts[3] (channel PDA) matches the session channelId
 *
 * Account indices come from open.rs: [payer, payee, mint, channelPda, payerTokenAccount, vault, ...].
 * Instruction data layout (Borsh): [0..8] discriminator, [8..16] salt (u64 LE), [16..24] deposit (u64 LE).
 */
function verifyOpenInstruction(
    instructions: RawInstruction[],
    channelProgram: string,
    expectedPayee: string,
    currency: string,
    expectedDeposit: bigint,
    expectedChannelId: string,
): void {
    const ix = findChannelInstruction(instructions, channelProgram);

    const data = decodeInstructionData(ix.data, 'open');

    if (!matchesDiscriminator(data, DISCRIMINATOR_OPEN)) {
        throw new Error(
            'Open transaction does not contain an open instruction (discriminator mismatch — possible replay with wrong action)',
        );
    }

    // deposit is a u64 LE at byte offset 16 (after 8-byte discriminator + 8-byte salt)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const onChainDeposit = view.getBigUint64(16, true);
    if (onChainDeposit !== expectedDeposit) {
        throw new Error(
            `Open: deposit amount mismatch (on-chain=${onChainDeposit}, payload=${expectedDeposit})`,
        );
    }

    const accounts = ix.accounts ?? [];

    if (accounts[1] !== expectedPayee) {
        throw new Error(
            `Open: payee mismatch (on-chain=${accounts[1]}, expected=${expectedPayee})`,
        );
    }

    // Only verify mint when currency is an SPL mint address (not 'sol').
    if (currency !== 'sol' && accounts[2] !== currency) {
        throw new Error(
            `Open: token mint mismatch (on-chain=${accounts[2]}, expected=${currency})`,
        );
    }

    if (accounts[3] !== expectedChannelId) {
        throw new Error(
            `Open: channel account mismatch (on-chain=${accounts[3]}, expected=${expectedChannelId})`,
        );
    }
}

/**
 * Verify that the transaction contains a valid mpp-channel `top_up` instruction.
 *
 * Checks:
 * - The channel program instruction has the `top_up` discriminator
 * - The amount encoded in instruction data matches the credential's additionalAmount
 * - accounts[1] (channel PDA) matches the session channelId
 *
 * Instruction data layout (Borsh): [0..8] discriminator, [8..16] amount (u64 LE).
 * Account indices come from top_up.rs: [payer, channel, token, vault, payerTokenAccount, tokenProgram].
 */
function verifyTopUpInstruction(
    instructions: RawInstruction[],
    channelProgram: string,
    expectedAmount: bigint,
    expectedChannelId: string,
): void {
    const ix = findChannelInstruction(instructions, channelProgram);

    const data = decodeInstructionData(ix.data, 'topUp');

    if (!matchesDiscriminator(data, DISCRIMINATOR_TOP_UP)) {
        throw new Error(
            'TopUp transaction does not contain a top_up instruction (discriminator mismatch)',
        );
    }

    // amount is a u64 LE at byte offset 8 (after 8-byte discriminator)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const onChainAmount = view.getBigUint64(8, true);
    if (onChainAmount !== expectedAmount) {
        throw new Error(
            `TopUp: amount mismatch (on-chain=${onChainAmount}, payload=${expectedAmount})`,
        );
    }

    const accounts = ix.accounts ?? [];

    if (accounts[1] !== expectedChannelId) {
        throw new Error(
            `TopUp: channel account mismatch (on-chain=${accounts[1]}, expected=${expectedChannelId})`,
        );
    }
}

function findChannelInstruction(instructions: RawInstruction[], channelProgram: string): RawInstruction {
    const matching = instructions.filter(i => i.programId === channelProgram);
    if (matching.length === 0) {
        throw new Error(`Transaction does not invoke the expected channel program ${channelProgram}`);
    }
    if (matching.length > 1) {
        throw new Error(
            `Transaction contains ${matching.length} channel-program instructions; expected exactly 1`,
        );
    }
    return matching[0];
}

function decodeInstructionData(data: string | undefined, label: string): Uint8Array {
    if (!data) {
        throw new Error(`${label} instruction is missing data`);
    }
    return new Uint8Array(getBase58Encoder().encode(data));
}

function matchesDiscriminator(data: Uint8Array, discriminator: Uint8Array): boolean {
    if (data.length < 8) return false;
    for (let i = 0; i < 8; i++) {
        if (data[i] !== discriminator[i]) return false;
    }
    return true;
}

// ---- RPC helpers ----

type RawInstruction = {
    /** Present for non-parsed programs: ordered list of account addresses. */
    accounts?: string[];
    /** Present for non-parsed programs: base58-encoded raw instruction data. */
    data?: string;
    programId?: string;
};

type ParsedTransaction = {
    meta: { err: unknown } | null;
    transaction: {
        message: {
            instructions: RawInstruction[];
        };
    };
};

async function fetchTransaction(rpcUrl: string, signature: string): Promise<ParsedTransaction | null> {
    const response = await fetch(rpcUrl, {
        body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'getTransaction',
            params: [signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    const data = (await response.json()) as { error?: { message: string }; result?: ParsedTransaction | null };
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
        throw new Error(`Transaction simulation failed: ${JSON.stringify(simErr)}. Logs: ${logs.join('; ')}`);
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
    const data = (await response.json()) as { error?: { message: string }; result?: string };
    if (data.error) throw new Error(`RPC error: ${data.error.message}`);
    if (!data.result) throw new Error('No signature returned from sendTransaction');
    return data.result;
}

async function waitForConfirmation(rpcUrl: string, signature: string, timeoutMs = 30_000): Promise<void> {
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
            result?: { value: ({ confirmationStatus: string; err: unknown } | null)[] };
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
