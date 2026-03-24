import type { TransactionSigner } from '@solana/kit';
import { type Challenge, Credential, Method, z } from 'mppx';

import * as Methods from '../Methods.js';
import type { SessionAuthorizer, SessionCredentialPayload } from '../session/Types.js';

type SessionChallengeRequest = {
    amount: string;
    currency: string;
    methodDetails: {
        channelId?: string;
        channelProgram: string;
        decimals?: number;
        feePayer?: boolean;
        feePayerKey?: string;
        minVoucherDelta?: string;
        network?: string;
    };
    recipient: string;
    suggestedDeposit?: string;
    unitType?: string;
};

type ActiveChannel = {
    channelId: string;
    channelProgram: string;
    cumulativeAmount: bigint;
    currency: string;
    depositAmount: bigint;
    network: string;
    recipient: string;
};

export const sessionContextSchema = z.object({
    action: z.optional(z.enum(['open', 'voucher', 'topUp', 'close'])),
    additionalAmount: z.optional(z.string()),
    channelId: z.optional(z.string()),
    cumulativeAmount: z.optional(z.string()),
    depositAmount: z.optional(z.string()),
});

export type SessionContext = z.infer<typeof sessionContextSchema>;

export function session(parameters: session.Parameters) {
    const { authorizer, autoOpen = true, autoTopup = false, settleOnLimitHit = false, onProgress } = parameters;

    let activeChannel: ActiveChannel | null = null;

    return Method.toClient(Methods.session, {
        context: sessionContextSchema,

        async createCredential({ challenge, context }) {
            const request = challenge.request as SessionChallengeRequest;
            const recipient = request.recipient;
            const network = request.methodDetails.network ?? 'mainnet-beta';
            const channelProgram = request.methodDetails.channelProgram;
            const currency = request.currency;
            const amount = request.amount;
            const feePayerKey = request.methodDetails.feePayerKey;

            onProgress?.({
                currency,
                network,
                recipient,
                type: 'challenge',
            });

            if (context?.action === 'topUp') {
                return await handleTopUpAction(
                    challenge,
                    context,
                    authorizer,
                    activeChannel,
                    channelProgram,
                    network,
                    feePayerKey,
                );
            }

            if (context?.action === 'close') {
                const credential = await handleCloseAction(challenge, context, authorizer, activeChannel, onProgress);

                activeChannel = null;
                return credential;
            }

            if (context?.action === 'open') {
                if (!context.channelId) {
                    throw new Error('channelId is required for open action');
                }

                if (!context.depositAmount) {
                    throw new Error('depositAmount is required for open action');
                }

                const channelId = context.channelId;
                const depositAmount = context.depositAmount;
                const parsedDepositAmount = parseNonNegativeAmount(depositAmount, 'context.depositAmount');

                onProgress?.({ channelId, type: 'opening' });

                const openResult = await authorizer.authorizeOpen({
                    channelId,
                    channelProgram,
                    currency,
                    decimals: request.methodDetails.decimals ?? 9,
                    depositAmount,
                    feePayerKey,
                    network,
                    recipient,
                });

                const payer = openResult.voucher.signer;

                const payload: SessionCredentialPayload = {
                    action: 'open',
                    channelId,
                    depositAmount,
                    payer,
                    transaction: openResult.transaction,
                    voucher: openResult.voucher,
                };

                activeChannel = {
                    channelId,
                    channelProgram,
                    cumulativeAmount: parseNonNegativeAmount(
                        openResult.voucher.voucher.cumulativeAmount,
                        'voucher.cumulativeAmount',
                    ),
                    currency,
                    depositAmount: parsedDepositAmount,
                    network,
                    recipient,
                };

                onProgress?.({ channelId, type: 'opened' });

                return Credential.serialize({
                    challenge,
                    payload,
                });
            }

            if (context?.action === 'voucher') {
                const channelId = context.channelId ?? activeChannel?.channelId;
                if (!channelId) {
                    throw new Error('channelId is required for voucher action');
                }

                if (!activeChannel || activeChannel.channelId !== channelId) {
                    throw new Error('Cannot submit voucher for a channel that is not active');
                }

                if (!context.cumulativeAmount) {
                    throw new Error('cumulativeAmount is required for voucher action');
                }

                const nextCumulativeAmount = parseNonNegativeAmount(
                    context.cumulativeAmount,
                    'context.cumulativeAmount',
                );

                onProgress?.({
                    channelId,
                    cumulativeAmount: nextCumulativeAmount.toString(),
                    type: 'voucher-submitting',
                });

                const voucherResult = await authorizer.authorizeVoucher({
                    channelId,
                    cumulativeAmount: nextCumulativeAmount.toString(),
                });

                const payload: SessionCredentialPayload = {
                    action: 'voucher',
                    channelId,
                    voucher: voucherResult.voucher,
                };

                activeChannel.cumulativeAmount = parseNonNegativeAmount(
                    voucherResult.voucher.voucher.cumulativeAmount,
                    'voucher.cumulativeAmount',
                );

                onProgress?.({
                    channelId,
                    cumulativeAmount: activeChannel.cumulativeAmount.toString(),
                    type: 'voucher-accepted',
                });

                return Credential.serialize({
                    challenge,
                    payload,
                });
            }

            // Auto-flow: no explicit action in context. Determine what to do based on channel state.
            const scopedActiveChannel =
                activeChannel &&
                matchesScope(activeChannel, {
                    channelProgram,
                    currency,
                    network,
                    recipient,
                })
                    ? activeChannel
                    : null;

            if (!scopedActiveChannel) {
                if (!autoOpen) {
                    throw new Error('No active session channel for challenge scope and autoOpen is disabled');
                }

                const channelId = crypto.randomUUID();
                const depositAmount = request.suggestedDeposit ?? '0';
                const parsedDepositAmount = parseNonNegativeAmount(depositAmount, 'suggestedDeposit');

                onProgress?.({ channelId, type: 'opening' });

                const openResult = await authorizer.authorizeOpen({
                    channelId,
                    channelProgram,
                    currency,
                    decimals: request.methodDetails.decimals ?? 9,
                    depositAmount,
                    feePayerKey,
                    network,
                    recipient,
                });

                const payer = openResult.voucher.signer;

                const payload: SessionCredentialPayload = {
                    action: 'open',
                    channelId,
                    depositAmount,
                    payer,
                    transaction: openResult.transaction,
                    voucher: openResult.voucher,
                };

                activeChannel = {
                    channelId,
                    channelProgram,
                    cumulativeAmount: parseNonNegativeAmount(
                        openResult.voucher.voucher.cumulativeAmount,
                        'voucher.cumulativeAmount',
                    ),
                    currency,
                    depositAmount: parsedDepositAmount,
                    network,
                    recipient,
                };

                onProgress?.({ channelId, type: 'opened' });

                return Credential.serialize({
                    challenge,
                    payload,
                });
            }

            // Auto-voucher: increment cumulative amount by the per-unit price.
            const debitIncrement = resolveDebitIncrement(amount, request.methodDetails.minVoucherDelta);
            const nextCumulativeAmount = scopedActiveChannel.cumulativeAmount + debitIncrement;

            if (nextCumulativeAmount > scopedActiveChannel.depositAmount) {
                if (!autoTopup) {
                    if (!settleOnLimitHit) {
                        throw new Error('Voucher cumulative amount exceeds tracked deposit and autoTopup is disabled');
                    }

                    const closeCredential = await handleCloseAction(
                        challenge,
                        {
                            action: 'close',
                            channelId: scopedActiveChannel.channelId,
                        },
                        authorizer,
                        scopedActiveChannel,
                        onProgress,
                    );

                    activeChannel = null;
                    return closeCredential;
                }

                const additionalAmount = resolveAutoTopupAmount(
                    request.suggestedDeposit,
                    nextCumulativeAmount,
                    scopedActiveChannel.depositAmount,
                );

                const topUpResult = await authorizer.authorizeTopUp({
                    additionalAmount: additionalAmount.toString(),
                    channelId: scopedActiveChannel.channelId,
                    channelProgram,
                    feePayerKey,
                    network,
                });

                scopedActiveChannel.depositAmount += additionalAmount;

                const payload: SessionCredentialPayload = {
                    action: 'topUp',
                    additionalAmount: additionalAmount.toString(),
                    channelId: scopedActiveChannel.channelId,
                    transaction: topUpResult.transaction,
                };

                return Credential.serialize({
                    challenge,
                    payload,
                });
            }

            onProgress?.({
                channelId: scopedActiveChannel.channelId,
                cumulativeAmount: nextCumulativeAmount.toString(),
                type: 'voucher-submitting',
            });

            const voucherResult = await authorizer.authorizeVoucher({
                channelId: scopedActiveChannel.channelId,
                cumulativeAmount: nextCumulativeAmount.toString(),
            });

            const payload: SessionCredentialPayload = {
                action: 'voucher',
                channelId: scopedActiveChannel.channelId,
                voucher: voucherResult.voucher,
            };

            scopedActiveChannel.cumulativeAmount = parseNonNegativeAmount(
                voucherResult.voucher.voucher.cumulativeAmount,
                'voucher.cumulativeAmount',
            );

            onProgress?.({
                channelId: scopedActiveChannel.channelId,
                cumulativeAmount: scopedActiveChannel.cumulativeAmount.toString(),
                type: 'voucher-accepted',
            });

            return Credential.serialize({
                challenge,
                payload,
            });
        },
    });
}

async function handleTopUpAction(
    challenge: Challenge.Challenge,
    context: SessionContext,
    authorizer: SessionAuthorizer,
    activeChannel: ActiveChannel | null,
    channelProgram: string,
    network: string,
    feePayerKey?: string,
): Promise<string> {
    const channelId = context.channelId ?? activeChannel?.channelId;
    if (!channelId) {
        throw new Error('channelId is required for topUp action');
    }
    if (!context.additionalAmount) {
        throw new Error('additionalAmount is required for topUp action');
    }

    const additionalAmount = parseNonNegativeAmount(context.additionalAmount, 'context.additionalAmount');

    const topUpResult = await authorizer.authorizeTopUp({
        additionalAmount: additionalAmount.toString(),
        channelId,
        channelProgram,
        feePayerKey,
        network,
    });

    if (activeChannel && activeChannel.channelId === channelId) {
        activeChannel.depositAmount += additionalAmount;
    }

    const payload: SessionCredentialPayload = {
        action: 'topUp',
        additionalAmount: additionalAmount.toString(),
        channelId,
        transaction: topUpResult.transaction,
    };

    return Credential.serialize({ challenge, payload });
}

async function handleCloseAction(
    challenge: Challenge.Challenge,
    context: SessionContext,
    authorizer: SessionAuthorizer,
    activeChannel: ActiveChannel | null,
    onProgress?: session.Parameters['onProgress'],
): Promise<string> {
    const channelId = context.channelId ?? activeChannel?.channelId;
    if (!channelId) {
        throw new Error('channelId is required for close action');
    }

    onProgress?.({ channelId, type: 'closing' });

    const closeResult = await authorizer.authorizeClose({
        channelId,
        finalCumulativeAmount: activeChannel?.cumulativeAmount.toString(),
    });

    const payload: SessionCredentialPayload = {
        action: 'close',
        channelId,
        ...(closeResult.voucher ? { voucher: closeResult.voucher } : {}),
    };

    onProgress?.({ channelId, type: 'closed' });

    return Credential.serialize({ challenge, payload });
}

function resolveDebitIncrement(amount: string, minVoucherDelta?: string): bigint {
    if (minVoucherDelta !== undefined) {
        return parseNonNegativeAmount(minVoucherDelta, 'minVoucherDelta');
    }

    if (amount !== undefined) {
        return parseNonNegativeAmount(amount, 'amount');
    }

    return 0n;
}

function resolveAutoTopupAmount(
    suggestedDeposit: string | undefined,
    nextCumulativeAmount: bigint,
    depositAmount: bigint,
): bigint {
    const shortfall = nextCumulativeAmount - depositAmount;
    if (shortfall <= 0n) {
        return 0n;
    }

    if (suggestedDeposit === undefined) {
        return shortfall;
    }

    const parsedSuggestedDeposit = parseNonNegativeAmount(suggestedDeposit, 'suggestedDeposit');
    return parsedSuggestedDeposit > shortfall ? parsedSuggestedDeposit : shortfall;
}

function matchesScope(
    active: ActiveChannel,
    scope: {
        channelProgram: string;
        currency: string;
        network: string;
        recipient: string;
    },
): boolean {
    return (
        active.recipient === scope.recipient &&
        active.network === scope.network &&
        active.channelProgram === scope.channelProgram &&
        active.currency === scope.currency
    );
}

function parseNonNegativeAmount(value: string, field: string): bigint {
    let amount: bigint;
    try {
        amount = BigInt(value);
    } catch {
        throw new Error(`${field} must be a valid integer string`);
    }

    if (amount < 0n) {
        throw new Error(`${field} must be non-negative`);
    }

    return amount;
}

export declare namespace session {
    type Parameters = {
        authorizer: SessionAuthorizer;
        autoOpen?: boolean;
        autoTopup?: boolean;
        onProgress?: (event: ProgressEvent) => void;
        settleOnLimitHit?: boolean;
        signer?: TransactionSigner;
    };

    type ProgressEvent =
        | { channelId: string; cumulativeAmount: string; type: 'voucher-accepted' }
        | { channelId: string; cumulativeAmount: string; type: 'voucher-submitting' }
        | { channelId: string; type: 'closed' }
        | { channelId: string; type: 'closing' }
        | { channelId: string; type: 'opened' }
        | { channelId: string; type: 'opening' }
        | { currency: string; network: string; recipient: string; type: 'challenge' };
}
