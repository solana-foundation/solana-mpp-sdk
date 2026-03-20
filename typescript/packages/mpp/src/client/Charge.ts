import {
    AccountRole,
    type Address,
    address,
    appendTransactionMessageInstructions,
    type Blockhash,
    createSolanaRpc,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    type Instruction,
    partiallySignTransactionMessageWithSigners,
    pipe,
    prependTransactionMessageInstructions,
    setTransactionMessageFeePayer,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signature as toSignature,
    signTransactionMessageWithSigners,
    type TransactionSigner,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstruction,
    getTransferCheckedInstruction,
} from '@solana-program/token';
import { Credential, Method } from 'mppx';

import { ASSOCIATED_TOKEN_PROGRAM, DEFAULT_RPC_URLS, TOKEN_PROGRAM } from '../constants.js';
import * as Methods from '../Methods.js';

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const textEncoder = new TextEncoder();

/**
 * Creates a Solana `charge` method for usage on the client.
 *
 * Supports two modes controlled by the `broadcast` option:
 *
 * - **Pull mode** (`broadcast: false`, default): Signs the transaction
 *   and sends the serialized bytes as a `type="transaction"` credential.
 *   The server broadcasts it to the Solana network.
 *
 * - **Push mode** (`broadcast: true`): Signs, broadcasts, confirms
 *   the transaction on-chain, and sends the signature as a `type="signature"`
 *   credential. Cannot be used with fee sponsorship.
 *
 * When the server advertises `feePayer: true` in the challenge, the client
 * sets the server's `feePayerKey` as the transaction fee payer and partially
 * signs (transfer authority only). The server adds its fee payer signature
 * before broadcasting.
 *
 * @example
 * ```ts
 * import { Mppx, solana } from 'solana-mpp-sdk/client'
 *
 * const method = solana.charge({ signer, rpcUrl: 'https://api.devnet.solana.com' })
 * const mppx = Mppx.create({ methods: [method] })
 *
 * const response = await mppx.fetch('https://api.example.com/paid-content')
 * console.log(await response.json())
 * ```
 */
export function charge(parameters: charge.Parameters) {
    const { signer, broadcast = false, onProgress } = parameters;

    const method = Method.toClient(Methods.charge, {
        async createCredential({ challenge }) {
            const { amount, currency, recipient, methodDetails } = challenge.request;
            const {
                network,
                decimals,
                reference,
                tokenProgram: tokenProgramAddr,
                feePayer: serverPaysFees,
                feePayerKey,
                recentBlockhash: serverBlockhash,
                splits,
            } = methodDetails;

            // currency is "sol" for native, or the mint address for SPL tokens.
            const mint = currency !== 'sol' ? currency : undefined;

            const rpcUrl =
                parameters.rpcUrl ?? DEFAULT_RPC_URLS[network || 'mainnet-beta'] ?? DEFAULT_RPC_URLS['mainnet-beta'];
            const rpc = createSolanaRpc(rpcUrl);
            onProgress?.({
                amount,
                currency,
                feePayerKey: feePayerKey || undefined,
                recipient,
                type: 'challenge',
            });

            const useServerFeePayer = serverPaysFees && feePayerKey && !broadcast;

            // Compute primary amount (total minus splits).
            const splitsTotal = (splits ?? []).reduce((sum, s) => sum + BigInt(s.amount), 0n);
            const primaryAmount = BigInt(amount) - splitsTotal;

            // Build transfer instructions.
            const instructions: Instruction[] = [];

            if (mint) {
                // ── SPL token transfers ──
                const mintAddress = address(mint);
                const tokenProg = address(tokenProgramAddr || TOKEN_PROGRAM);
                const tokenDecimals = decimals ?? 6;

                const [sourceAta] = await findAssociatedTokenPda({
                    mint: mintAddress,
                    owner: signer.address,
                    tokenProgram: tokenProg,
                });

                // Helper: add ATA creation + transferChecked for a recipient.
                const addSplTransfer = async (dest: string, transferAmount: bigint) => {
                    const [destAta] = await findAssociatedTokenPda({
                        mint: mintAddress,
                        owner: address(dest),
                        tokenProgram: tokenProg,
                    });

                    // Create destination ATA if it doesn't exist (idempotent).
                    if (useServerFeePayer) {
                        instructions.push(
                            createAssociatedTokenAccountIdempotent(
                                address(feePayerKey),
                                address(dest),
                                mintAddress,
                                destAta,
                                tokenProg,
                            ),
                        );
                    } else {
                        instructions.push(
                            getCreateAssociatedTokenIdempotentInstruction({
                                ata: destAta,
                                mint: mintAddress,
                                owner: address(dest),
                                payer: signer,
                                tokenProgram: tokenProg,
                            }),
                        );
                    }

                    instructions.push(
                        getTransferCheckedInstruction(
                            {
                                amount: transferAmount,
                                authority: signer,
                                decimals: tokenDecimals,
                                destination: destAta,
                                mint: mintAddress,
                                source: sourceAta,
                            },
                            { programAddress: tokenProg },
                        ),
                    );
                };

                // Primary transfer to recipient.
                await addSplTransfer(recipient, primaryAmount);

                // Split transfers.
                for (const split of splits ?? []) {
                    await addSplTransfer(split.recipient, BigInt(split.amount));
                }
            } else {
                // ── Native SOL transfers ──
                // Primary transfer to recipient.
                instructions.push(
                    getTransferSolInstruction({
                        amount: primaryAmount,
                        destination: address(recipient),
                        source: signer,
                    }),
                );

                // Split transfers.
                for (const split of splits ?? []) {
                    instructions.push(
                        getTransferSolInstruction({
                            amount: BigInt(split.amount),
                            destination: address(split.recipient),
                            source: signer,
                        }),
                    );
                }
            }

            if (reference?.trim()) {
                instructions.push(createReferenceMemoInstruction(reference, signer));
            }

            onProgress?.({ type: 'signing' });

            // Use server-provided blockhash if available, otherwise fetch one.
            const latestBlockhash = serverBlockhash
                ? {
                      blockhash: serverBlockhash as Blockhash,
                      lastValidBlockHeight: BigInt(0), // Server doesn't provide this; tx lifetime is managed by the blockhash itself.
                  }
                : (await rpc.getLatestBlockhash().send()).value;

            const txMessage = pipe(
                createTransactionMessage({ version: 0 }),
                msg =>
                    useServerFeePayer
                        ? setTransactionMessageFeePayer(address(feePayerKey), msg)
                        : setTransactionMessageFeePayerSigner(signer, msg),
                msg => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
                msg => appendTransactionMessageInstructions(instructions, msg),
                // Prepend compute budget instructions per best practice.
                msg =>
                    prependTransactionMessageInstructions(
                        [
                            getSetComputeUnitPriceInstruction({ microLamports: parameters.computeUnitPrice ?? 1n }),
                            getSetComputeUnitLimitInstruction({ units: parameters.computeUnitLimit ?? 200_000 }),
                        ],
                        msg,
                    ),
            );

            // When server pays fees, partially sign (only the transfer authority).
            // The server will add its fee payer signature before broadcasting.
            const signedTx = useServerFeePayer
                ? await partiallySignTransactionMessageWithSigners(txMessage)
                : await signTransactionMessageWithSigners(txMessage);

            const encodedTx = getBase64EncodedWireTransaction(signedTx);

            if (broadcast) {
                // ── Push mode (type="signature") ──
                onProgress?.({ type: 'paying' });

                const signature = await rpc
                    .sendTransaction(encodedTx, {
                        encoding: 'base64',
                        skipPreflight: false,
                    })
                    .send();

                onProgress?.({ signature, type: 'confirming' });
                await confirmTransaction(rpc, signature);
                onProgress?.({ signature, type: 'paid' });

                return Credential.serialize({
                    challenge,
                    payload: { signature, type: 'signature' },
                });
            }

            // ── Pull mode (type="transaction", default) ──
            onProgress?.({ transaction: encodedTx, type: 'signed' });

            return Credential.serialize({
                challenge,
                payload: { transaction: encodedTx, type: 'transaction' },
            });
        },
    });

    return method;
}

// ── Helpers ──

/**
 * Creates an Associated Token Account using the idempotent instruction
 * (CreateIdempotent = discriminator 1). This is a no-op if the ATA exists.
 *
 * Used in fee payer mode where the payer is the server's key (not a local
 * signer). The server adds its signature before broadcasting.
 */
function createAssociatedTokenAccountIdempotent(
    payer: Address,
    owner: Address,
    mint: Address,
    ata: Address,
    tokenProgram: Address,
): Instruction {
    return {
        accounts: [
            { address: payer, role: AccountRole.WRITABLE_SIGNER },
            { address: ata, role: AccountRole.WRITABLE },
            { address: owner, role: AccountRole.READONLY },
            { address: mint, role: AccountRole.READONLY },
            { address: address('11111111111111111111111111111111'), role: AccountRole.READONLY },
            { address: tokenProgram, role: AccountRole.READONLY },
        ],
        data: new Uint8Array([1]),
        programAddress: address(ASSOCIATED_TOKEN_PROGRAM), // CreateIdempotent discriminator
    };
}

/**
 * Adds challenge reference as memo to make rapid identical payments unique
 * per challenge (important for local simnets such as Surfpool).
 */
function createReferenceMemoInstruction(reference: string, memoSigner: TransactionSigner): Instruction {
    return {
        accounts: [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { address: memoSigner.address, role: AccountRole.READONLY_SIGNER, signer: memoSigner } as any,
        ],
        data: textEncoder.encode(`mppx:${reference}`),
        programAddress: address(MEMO_PROGRAM),
    };
}

/**
 * Polls for transaction confirmation via getSignatureStatuses.
 * Only used in push mode.
 */
async function confirmTransaction(rpc: ReturnType<typeof createSolanaRpc>, signature: string, timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const { value } = await rpc.getSignatureStatuses([toSignature(signature)]).send();
        const status = value[0];
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
         * If true, the client broadcasts the transaction and sends the signature
         * as a `type="signature"` credential. If false (default), the client sends
         * the signed transaction bytes as a `type="transaction"` credential and the
         * server broadcasts it.
         *
         * Cannot be used with server fee sponsorship (feePayer mode).
         */
        broadcast?: boolean;
        /** Compute unit limit. Defaults to 200,000. */
        computeUnitLimit?: number;
        /** Compute unit price in micro-lamports for priority fees. Defaults to 1. */
        computeUnitPrice?: bigint;
        /** Called at each step of the payment process. */
        onProgress?: (event: ProgressEvent) => void;
        /** Custom RPC URL. If not set, inferred from the challenge's network field. */
        rpcUrl?: string;
        /**
         * Solana transaction signer. Compatible with:
         * - ConnectorKit's `useTransactionSigner()` hook
         * - `createKeyPairSignerFromBytes()` from `@solana/kit` for headless usage
         * - Solana Keychain's `SolanaSigner` for remote signers
         * - Any `TransactionSigner` implementation
         */
        signer: TransactionSigner;
    };

    type ProgressEvent =
        | {
              amount: string;
              currency: string;
              feePayerKey?: string;
              recipient: string;
              type: 'challenge';
          }
        | { signature: string; type: 'confirming' }
        | { signature: string; type: 'paid' }
        | { transaction: string; type: 'signed' }
        | { type: 'paying' }
        | { type: 'signing' };
}
