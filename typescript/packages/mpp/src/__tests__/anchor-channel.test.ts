/**
 * Anchor integration tests for the mpp-channel program.
 *
 * Runs against solana-test-validator with the program loaded.
 * Requires: `anchor build --no-idl` to have been run first.
 *
 * Run: `pnpm exec vitest run --config vitest.config.anchor.ts`
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
    address,
    generateKeyPairSigner,
    createTransactionMessage,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    appendTransactionMessageInstructions,
    compileTransaction,
    partiallySignTransaction,
    getBase64EncodedWireTransaction,
    getBase58Encoder,
    type Address,
    type KeyPairSigner,
    type Instruction,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
    getInitializeMintInstruction,
    getMintToInstruction,
    getCreateAssociatedTokenIdempotentInstruction,
    findAssociatedTokenPda,
    TOKEN_PROGRAM_ADDRESS,
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

import {
    deriveChannelPda,
    deriveVaultPda,
    buildOpenInstruction,
    buildSettleInstructions,
    buildTopUpInstruction,
    buildRequestCloseInstruction,
    buildWithdrawInstruction,
    buildCloseInstructions,
} from '../anchor/MppChannelClient.js';
import { serializeVoucher, signVoucher } from '../session/Voucher.js';

const PROGRAM_ID = address('21fLdahqKtVAt4V2JLwVrRb7tuqPADjjPVCU9bK3MFPQ');
const PROGRAM_SO_PATH = new URL('../../../../../programs/mpp-channel/target/deploy/mpp_channel.so', import.meta.url)
    .pathname;
const RPC_URL = 'http://127.0.0.1:8899';
const GRACE_PERIOD = 2n; // 2 seconds for testing
const MINT_DECIMALS = 6;

let validatorProcess: ChildProcess | null = null;
let payer: KeyPairSigner;
let payee: KeyPairSigner;
let mint: Address;
let payerAta: Address;
let payeeAta: Address;
const base58Encoder = getBase58Encoder();

// ---- RPC helpers ----

async function rpcCall(method: string, params: unknown[] = []): Promise<unknown> {
    const response = await fetch(RPC_URL, {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    const data = (await response.json()) as { error?: { message: string }; result?: unknown };
    if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
    return data.result;
}

async function airdrop(recipient: Address, lamports: number): Promise<void> {
    const signature = (await rpcCall('requestAirdrop', [recipient, lamports])) as string;
    await waitForSignature(signature);
}

async function waitForSignature(signature: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
        const result = (await rpcCall('getSignatureStatuses', [[signature]])) as {
            value: ({ confirmationStatus: string; err: unknown } | null)[];
        };
        const status = result.value[0];
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
            return;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Confirmation timeout');
}

async function getBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
    const result = (await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }])) as {
        value: { blockhash: string; lastValidBlockHeight: number };
    };
    return { blockhash: result.value.blockhash, lastValidBlockHeight: BigInt(result.value.lastValidBlockHeight) };
}

async function sendTx(instructions: Instruction[], signers: KeyPairSigner[]): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await getBlockhash();
    const feePayer = signers[0];

    const msg = appendTransactionMessageInstructions(
        instructions,
        setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: blockhash as any, lastValidBlockHeight },
            setTransactionMessageFeePayer(feePayer.address, createTransactionMessage({ version: 0 })),
        ),
    );

    // Compile the message to a transaction, then sign with all provided key pairs.
    const compiled = compileTransaction(msg as any);
    const keyPairs = await Promise.all(signers.map(s => s.keyPair));
    const signed = await partiallySignTransaction(keyPairs as any, compiled);
    const base64Tx = getBase64EncodedWireTransaction(signed as any);

    const signature = (await rpcCall('sendTransaction', [
        base64Tx,
        { encoding: 'base64', skipPreflight: true },
    ])) as string;
    await waitForSignature(signature);
    return signature;
}

async function getTokenBalance(tokenAccount: Address): Promise<bigint> {
    const result = (await rpcCall('getTokenAccountBalance', [tokenAccount, { commitment: 'confirmed' }])) as {
        value: { amount: string };
    };
    return BigInt(result.value.amount);
}

async function getAccountData(accountAddress: Address): Promise<Uint8Array | null> {
    const result = (await rpcCall('getAccountInfo', [
        accountAddress,
        { encoding: 'base64', commitment: 'confirmed' },
    ])) as {
        value: { data: [string, string] } | null;
    };
    if (!result?.value) return null;
    const base64Data = result.value.data[0];
    return Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
}

// ---- Validator lifecycle ----

async function startValidator(): Promise<void> {
    const repoRoot = new URL('../../../../../', import.meta.url).pathname;

    validatorProcess = spawn(
        'solana-test-validator',
        ['--bpf-program', PROGRAM_ID, PROGRAM_SO_PATH, '--reset', '--quiet'],
        {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: repoRoot,
        },
    );

    let processOutput = '';
    validatorProcess.stdout?.on('data', (data: Buffer) => {
        processOutput += data.toString();
    });
    validatorProcess.stderr?.on('data', (data: Buffer) => {
        processOutput += data.toString();
    });

    for (let i = 0; i < 60; i++) {
        try {
            await rpcCall('getHealth');
            return;
        } catch {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    throw new Error(`Validator startup failed. output: ${processOutput}`);
}

// ---- Token setup ----

async function setupTestTokens(): Promise<void> {
    const mintKeypair = await generateKeyPairSigner();
    const rentExemption = (await rpcCall('getMinimumBalanceForRentExemption', [82])) as number;

    const createMintAccountIx = getCreateAccountInstruction({
        payer,
        newAccount: mintKeypair,
        lamports: BigInt(rentExemption),
        space: 82,
        programAddress: TOKEN_PROGRAM_ADDRESS,
    });

    const initMintIx = getInitializeMintInstruction({
        mint: mintKeypair.address,
        decimals: MINT_DECIMALS,
        mintAuthority: payer.address,
    });

    await sendTx([createMintAccountIx, initMintIx], [payer, mintKeypair]);
    mint = mintKeypair.address;

    // Create ATAs for payer and payee.
    const [payerAtaAddr] = await findAssociatedTokenPda({
        mint,
        owner: payer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [payeeAtaAddr] = await findAssociatedTokenPda({
        mint,
        owner: payee.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const createPayerAta = getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: payerAtaAddr,
        owner: payer.address,
        mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const createPayeeAta = getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: payeeAtaAddr,
        owner: payee.address,
        mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    await sendTx([createPayerAta, createPayeeAta], [payer]);
    payerAta = payerAtaAddr;
    payeeAta = payeeAtaAddr;

    // Mint tokens to payer.
    const mintToIx = getMintToInstruction({
        mint,
        token: payerAta,
        mintAuthority: payer,
        amount: 10_000_000n, // 10 tokens at 6 decimals
    });
    await sendTx([mintToIx], [payer]);
}

// ---- Tests ----

describe('mpp-channel program', () => {
    beforeAll(async () => {
        await startValidator();
        payer = await generateKeyPairSigner();
        payee = await generateKeyPairSigner();
        await airdrop(payer.address, 10_000_000_000);
        await airdrop(payee.address, 1_000_000_000);

        // Wait for airdrop to be queryable.
        for (let attempt = 0; attempt < 30; attempt++) {
            const payerBalance = (await rpcCall('getBalance', [payer.address])) as { value: number };
            if (payerBalance.value > 0) break;
            if (attempt === 29) throw new Error('Payer airdrop did not land after 15 seconds');
            await new Promise(r => setTimeout(r, 500));
        }

        await setupTestTokens();
    }, 60_000);

    afterAll(() => {
        if (validatorProcess) {
            validatorProcess.kill('SIGTERM');
            validatorProcess = null;
        }
    });

    test('open creates channel PDA and deposits tokens', async () => {
        const salt = 100n;
        const depositAmount = 1_000_000n;

        const [channelPda] = await deriveChannelPda(
            PROGRAM_ID,
            payer.address,
            payee.address,
            mint,
            salt,
            payer.address,
        );
        const vaultPda = await deriveVaultPda(channelPda, mint);

        const openIx = buildOpenInstruction({
            programId: PROGRAM_ID,
            payer: payer.address,
            payee: payee.address,
            mint,
            channelPda,
            payerTokenAccount: payerAta,
            vault: vaultPda,
            salt,
            deposit: depositAmount,
            gracePeriodSeconds: GRACE_PERIOD,
            authorizedSigner: payer.address,
        });

        await sendTx([openIx], [payer]);

        const vaultBalance = await getTokenBalance(vaultPda);
        expect(vaultBalance).toBe(depositAmount);
    });

    test('settle transfers delta to payee with Ed25519 voucher', async () => {
        const salt = 200n;
        const depositAmount = 1_000_000n;
        const settleAmount = 300_000n;

        const [channelPda] = await deriveChannelPda(
            PROGRAM_ID,
            payer.address,
            payee.address,
            mint,
            salt,
            payer.address,
        );
        const vaultPda = await deriveVaultPda(channelPda, mint);

        // Open channel.
        await sendTx(
            [
                buildOpenInstruction({
                    programId: PROGRAM_ID,
                    payer: payer.address,
                    payee: payee.address,
                    mint,
                    channelPda,
                    payerTokenAccount: payerAta,
                    vault: vaultPda,
                    salt,
                    deposit: depositAmount,
                    gracePeriodSeconds: GRACE_PERIOD,
                    authorizedSigner: payer.address,
                }),
            ],
            [payer],
        );

        // Sign a voucher.
        const voucher = { channelId: channelPda, cumulativeAmount: settleAmount.toString() };
        const voucherBytes = serializeVoucher(voucher);
        const signedVoucher = await signVoucher(payer, voucher);
        const signatureBytes = new Uint8Array(base58Encoder.encode(signedVoucher.signature));
        const signerPubkeyBytes = new Uint8Array(base58Encoder.encode(payer.address));

        // Build settle tx with Ed25519 verify + settle instructions.
        const settleIxs = buildSettleInstructions({
            programId: PROGRAM_ID,
            payee: payee.address,
            channelPda,
            mint,
            vault: vaultPda,
            payeeTokenAccount: payeeAta,
            cumulativeAmount: settleAmount,
            voucherMessage: voucherBytes,
            signerPublicKey: signerPubkeyBytes,
            signature: signatureBytes,
        });

        const payeeBalanceBefore = await getTokenBalance(payeeAta);
        await sendTx(settleIxs, [payee]);
        const payeeBalanceAfter = await getTokenBalance(payeeAta);

        expect(payeeBalanceAfter - payeeBalanceBefore).toBe(settleAmount);
    });

    test('full lifecycle: open -> settle -> settle more -> close', async () => {
        const salt = 300n;
        const depositAmount = 1_000_000n;

        const [channelPda] = await deriveChannelPda(
            PROGRAM_ID,
            payer.address,
            payee.address,
            mint,
            salt,
            payer.address,
        );
        const vaultPda = await deriveVaultPda(channelPda, mint);

        // Open.
        await sendTx(
            [
                buildOpenInstruction({
                    programId: PROGRAM_ID,
                    payer: payer.address,
                    payee: payee.address,
                    mint,
                    channelPda,
                    payerTokenAccount: payerAta,
                    vault: vaultPda,
                    salt,
                    deposit: depositAmount,
                    gracePeriodSeconds: GRACE_PERIOD,
                    authorizedSigner: payer.address,
                }),
            ],
            [payer],
        );

        // Settle partial (200k).
        const voucher1 = { channelId: channelPda, cumulativeAmount: '200000' };
        const signed1 = await signVoucher(payer, voucher1);
        await sendTx(
            buildSettleInstructions({
                programId: PROGRAM_ID,
                payee: payee.address,
                channelPda,
                mint,
                vault: vaultPda,
                payeeTokenAccount: payeeAta,
                cumulativeAmount: 200_000n,
                voucherMessage: serializeVoucher(voucher1),
                signerPublicKey: new Uint8Array(base58Encoder.encode(payer.address)),
                signature: new Uint8Array(base58Encoder.encode(signed1.signature)),
            }),
            [payee],
        );

        // Settle more (500k cumulative).
        const voucher2 = { channelId: channelPda, cumulativeAmount: '500000' };
        const signed2 = await signVoucher(payer, voucher2);
        await sendTx(
            buildSettleInstructions({
                programId: PROGRAM_ID,
                payee: payee.address,
                channelPda,
                mint,
                vault: vaultPda,
                payeeTokenAccount: payeeAta,
                cumulativeAmount: 500_000n,
                voucherMessage: serializeVoucher(voucher2),
                signerPublicKey: new Uint8Array(base58Encoder.encode(payer.address)),
                signature: new Uint8Array(base58Encoder.encode(signed2.signature)),
            }),
            [payee],
        );

        // Close with final voucher (700k cumulative).
        const voucher3 = { channelId: channelPda, cumulativeAmount: '700000' };
        const signed3 = await signVoucher(payer, voucher3);
        const payerBalanceBefore = await getTokenBalance(payerAta);

        await sendTx(
            buildCloseInstructions({
                programId: PROGRAM_ID,
                payee: payee.address,
                channelPda,
                mint,
                vault: vaultPda,
                payeeTokenAccount: payeeAta,
                payerTokenAccount: payerAta,
                cumulativeAmount: 700_000n,
                voucherMessage: serializeVoucher(voucher3),
                signerPublicKey: new Uint8Array(base58Encoder.encode(payer.address)),
                signature: new Uint8Array(base58Encoder.encode(signed3.signature)),
            }),
            [payee],
        );

        // Payer should get refund of 300k (1M - 700k).
        const payerBalanceAfter = await getTokenBalance(payerAta);
        expect(payerBalanceAfter - payerBalanceBefore).toBe(300_000n);

        // Vault should be empty.
        const vaultBalance = await getTokenBalance(vaultPda);
        expect(vaultBalance).toBe(0n);
    });

    test('requestClose + withdraw after grace period', async () => {
        const salt = 400n;
        const depositAmount = 500_000n;

        const [channelPda] = await deriveChannelPda(
            PROGRAM_ID,
            payer.address,
            payee.address,
            mint,
            salt,
            payer.address,
        );
        const vaultPda = await deriveVaultPda(channelPda, mint);

        // Open.
        await sendTx(
            [
                buildOpenInstruction({
                    programId: PROGRAM_ID,
                    payer: payer.address,
                    payee: payee.address,
                    mint,
                    channelPda,
                    payerTokenAccount: payerAta,
                    vault: vaultPda,
                    salt,
                    deposit: depositAmount,
                    gracePeriodSeconds: GRACE_PERIOD,
                    authorizedSigner: payer.address,
                }),
            ],
            [payer],
        );

        // Request close.
        await sendTx(
            [
                buildRequestCloseInstruction({
                    programId: PROGRAM_ID,
                    payer: payer.address,
                    channelPda,
                }),
            ],
            [payer],
        );

        // Wait for grace period to expire.
        await new Promise(r => setTimeout(r, 3000));

        // Withdraw.
        const payerBalanceBefore = await getTokenBalance(payerAta);
        await sendTx(
            [
                buildWithdrawInstruction({
                    programId: PROGRAM_ID,
                    payer: payer.address,
                    channelPda,
                    mint,
                    vault: vaultPda,
                    payerTokenAccount: payerAta,
                }),
            ],
            [payer],
        );
        const payerBalanceAfter = await getTokenBalance(payerAta);

        expect(payerBalanceAfter - payerBalanceBefore).toBe(depositAmount);
    });

    test('topUp increases deposit and cancels pending close', async () => {
        const salt = 500n;
        const depositAmount = 500_000n;
        const topUpAmount = 200_000n;

        const [channelPda] = await deriveChannelPda(
            PROGRAM_ID,
            payer.address,
            payee.address,
            mint,
            salt,
            payer.address,
        );
        const vaultPda = await deriveVaultPda(channelPda, mint);

        // Open.
        await sendTx(
            [
                buildOpenInstruction({
                    programId: PROGRAM_ID,
                    payer: payer.address,
                    payee: payee.address,
                    mint,
                    channelPda,
                    payerTokenAccount: payerAta,
                    vault: vaultPda,
                    salt,
                    deposit: depositAmount,
                    gracePeriodSeconds: GRACE_PERIOD,
                    authorizedSigner: payer.address,
                }),
            ],
            [payer],
        );

        // Request close.
        await sendTx(
            [
                buildRequestCloseInstruction({
                    programId: PROGRAM_ID,
                    payer: payer.address,
                    channelPda,
                }),
            ],
            [payer],
        );

        // TopUp should cancel the close request.
        await sendTx(
            [
                buildTopUpInstruction({
                    programId: PROGRAM_ID,
                    payer: payer.address,
                    channelPda,
                    mint,
                    vault: vaultPda,
                    payerTokenAccount: payerAta,
                    amount: topUpAmount,
                }),
            ],
            [payer],
        );

        const vaultBalance = await getTokenBalance(vaultPda);
        expect(vaultBalance).toBe(depositAmount + topUpAmount);

        // After topUp, withdraw should fail because closeRequestedAt was reset.
        // We'd need to requestClose again and wait.
    });
});
