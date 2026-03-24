import { Method, Receipt, Store } from 'mppx';

import * as Methods from '../Methods.js';
import * as ChannelStore from '../session/ChannelStore.js';
import type {
    ChannelState,
    SessionCredentialPayload,
    SignedSessionVoucher,
    VoucherVerifier,
} from '../session/Types.js';
import { parseVoucherFromPayload, verifyVoucherSignature } from '../session/Voucher.js';

type SessionRequest = {
    amount: string;
    currency: string;
    description?: string;
    externalId?: string;
    methodDetails: {
        channelId?: string;
        channelProgram: string;
        decimals?: number;
        feePayer?: boolean;
        feePayerKey?: string;
        gracePeriodSeconds?: number;
        minVoucherDelta?: string;
        network?: string;
        tokenProgram?: string;
        ttlSeconds?: number;
    };
    recipient: string;
    suggestedDeposit?: string;
    unitType?: string;
};

type SessionChallenge = {
    id?: string;
    request: SessionRequest;
};

type OpenPayload = Extract<SessionCredentialPayload, { action: 'open' }>;
type VoucherPayload = Extract<SessionCredentialPayload, { action: 'voucher' }>;
type TopUpPayload = Extract<SessionCredentialPayload, { action: 'topUp' }>;
type ClosePayload = Extract<SessionCredentialPayload, { action: 'close' }>;

type TransactionHandler = {
    /** Inspect and broadcast a partially-signed open transaction. Returns the confirmed signature. */
    handleOpen?(channelId: string, transaction: string, deposit: string): Promise<string>;
    /** Inspect and broadcast a partially-signed top-up transaction. Returns the confirmed signature. */
    handleTopUp?(channelId: string, transaction: string, amount: string): Promise<string>;
};

export function session(parameters: session.Parameters) {
    const { recipient, currency, channelProgram, store = Store.memory() } = parameters;
    const network = parameters.network ?? 'mainnet-beta';

    assertSessionParameters(parameters);

    const channelStore = ChannelStore.fromStore(store);

    return Method.toServer(Methods.session, {
        defaults: {
            amount: '0',
            currency: '',
            methodDetails: { channelProgram: '' },
            recipient: '',
        },

        request({ credential, request }) {
            if (credential) {
                return credential.challenge.request as typeof request;
            }

            return {
                ...request,
                amount: parameters.amount,
                currency,
                methodDetails: {
                    channelProgram,
                    ...(parameters.decimals !== undefined ? { decimals: parameters.decimals } : {}),
                    ...(parameters.feePayer ? { feePayer: true, feePayerKey: parameters.feePayerKey } : {}),
                    ...(parameters.gracePeriodSeconds !== undefined
                        ? { gracePeriodSeconds: parameters.gracePeriodSeconds }
                        : {}),
                    ...(parameters.minVoucherDelta ? { minVoucherDelta: parameters.minVoucherDelta } : {}),
                    network,
                    ...(parameters.ttlSeconds !== undefined ? { ttlSeconds: parameters.ttlSeconds } : {}),
                },
                recipient,
                ...(parameters.suggestedDeposit ? { suggestedDeposit: parameters.suggestedDeposit } : {}),
                ...(parameters.unitType ? { unitType: parameters.unitType } : {}),
            };
        },

        respond({ credential }) {
            const payload = credential.payload as SessionCredentialPayload;

            if (payload.action === 'close') {
                return new Response(null, { status: 204 });
            }

            if (payload.action === 'topUp') {
                return new Response(null, { status: 204 });
            }

            return undefined;
        },

        async verify({ credential }) {
            const payload = credential.payload as SessionCredentialPayload;
            const challenge = credential.challenge as SessionChallenge;
            const challengeId = challenge.id;

            switch (payload.action) {
                case 'open':
                    return await handleOpen(channelStore, payload, challenge, parameters, challengeId);
                case 'voucher':
                    return await handleVoucher(channelStore, payload, parameters, challengeId);
                case 'topUp':
                    return await handleTopUp(channelStore, payload, parameters, challengeId);
                case 'close':
                    return await handleClose(channelStore, payload, parameters, challengeId);
                default: {
                    const exhaustive: never = payload;
                    throw new Error(`Unknown session action: ${(exhaustive as { action?: string }).action}`);
                }
            }
        },
    });
}

async function handleOpen(
    channelStore: ChannelStore.ChannelStore,
    payload: OpenPayload,
    challenge: SessionChallenge,
    parameters: session.Parameters,
    challengeId?: string,
) {
    const voucher = parseVoucherFromPayload(payload);

    const depositAmount = parseNonNegativeAmount(payload.depositAmount, 'depositAmount');
    const cumulativeAmount = parseNonNegativeAmount(voucher.voucher.cumulativeAmount, 'voucher.cumulativeAmount');

    if (!payload.transaction.trim()) {
        throw new Error('transaction is required for session open');
    }

    if (voucher.voucher.channelId !== payload.channelId) {
        throw new Error('Voucher channelId mismatch for open action');
    }

    if (cumulativeAmount > depositAmount) {
        throw new Error('Voucher cumulative amount exceeds channel deposit');
    }

    assertVoucherNotExpired(voucher, parameters.maxClockSkewSeconds);

    // Inspect and broadcast the partially-signed transaction via the handler.
    let openTxSignature: string | undefined;
    if (parameters.transactionHandler?.handleOpen) {
        openTxSignature = await parameters.transactionHandler.handleOpen(
            payload.channelId,
            payload.transaction,
            payload.depositAmount,
        );
    }

    const createdAt = new Date().toISOString();

    const nextState: ChannelState = {
        acceptedCumulative: cumulativeAmount.toString(),
        // authorizationPolicy is stored for custom verifiers (e.g. SwigSessionAuthorizer).
        // It is not enforced by the built-in ed25519 verification path.
        ...(payload.authorizationPolicy ? { authorizationPolicy: payload.authorizationPolicy } : {}),
        authorizedSigner: voucher.signer,
        channelId: payload.channelId,
        closeRequestedAt: 0,
        createdAt,
        currency: parameters.currency,
        decimals: parameters.decimals ?? 9,
        escrowedAmount: depositAmount.toString(),
        finalized: false,
        payee: parameters.recipient,
        payer: payload.payer,
        settledOnChain: '0',
        spentAmount: '0',
        status: 'open',
    };

    await verifySignedVoucher(voucher, nextState, parameters.voucherVerifier);

    await channelStore.updateChannel(payload.channelId, current => {
        if (current) {
            throw new Error(`Channel already exists: ${payload.channelId}`);
        }

        return nextState;
    });

    return toSessionReceipt(
        openTxSignature ?? payload.channelId,
        nextState.acceptedCumulative,
        nextState.spentAmount,
        challengeId,
    );
}

async function handleVoucher(
    channelStore: ChannelStore.ChannelStore,
    payload: VoucherPayload,
    parameters: session.Parameters,
    challengeId?: string,
) {
    const channel = await channelStore.getChannel(payload.channelId);
    if (!channel) {
        throw new Error(`Channel not found: ${payload.channelId}`);
    }

    assertChannelOpen(channel);

    // Reject new vouchers on channels with a pending forced close.
    if (channel.closeRequestedAt > 0) {
        throw new Error(`Channel has a pending forced close (requested at ${channel.closeRequestedAt})`);
    }

    const voucher = parseVoucherFromPayload(payload);
    assertVoucherNotExpired(voucher, parameters.maxClockSkewSeconds);

    if (voucher.voucher.channelId !== channel.channelId) {
        throw new Error('Voucher channelId mismatch');
    }

    await verifySignedVoucher(voucher, channel, parameters.voucherVerifier);

    const cumulativeAmount = parseNonNegativeAmount(voucher.voucher.cumulativeAmount, 'voucher.cumulativeAmount');
    const escrowedAmount = parseNonNegativeAmount(channel.escrowedAmount, 'channel.escrowedAmount');
    const acceptedCumulative = parseNonNegativeAmount(channel.acceptedCumulative, 'channel.acceptedCumulative');

    // Idempotent retry: equal cumulative amount is a re-send of an already-accepted voucher.
    if (cumulativeAmount === acceptedCumulative) {
        return toSessionReceipt(payload.channelId, channel.acceptedCumulative, channel.spentAmount, challengeId);
    }

    // Reject stale vouchers. A lower amount was already superseded — accepting it would
    // authorize no new value while still allowing the resource to be served.
    if (cumulativeAmount < acceptedCumulative) {
        throw new Error(
            `Voucher cumulative amount must not decrease (received ${cumulativeAmount}, accepted ${acceptedCumulative})`,
        );
    }

    if (cumulativeAmount > escrowedAmount) {
        throw new Error('Voucher cumulative amount exceeds channel deposit');
    }

    const updatedChannel = await channelStore.updateChannel(payload.channelId, current => {
        if (!current) {
            throw new Error(`Channel not found: ${payload.channelId}`);
        }

        assertChannelOpen(current);

        // Re-check closeRequestedAt inside atomic update (TOCTOU guard).
        if (current.closeRequestedAt > 0) {
            throw new Error(`Channel has a pending forced close (requested at ${current.closeRequestedAt})`);
        }

        const currentAccepted = parseNonNegativeAmount(current.acceptedCumulative, 'channel.acceptedCumulative');

        // Re-check inside atomic update (idempotent retry — another request may have raced ahead).
        if (cumulativeAmount === currentAccepted) {
            return current;
        }

        if (cumulativeAmount < currentAccepted) {
            throw new Error(
                `Voucher cumulative amount must not decrease (received ${cumulativeAmount}, accepted ${currentAccepted})`,
            );
        }

        const currentEscrowed = parseNonNegativeAmount(current.escrowedAmount, 'channel.escrowedAmount');
        if (cumulativeAmount > currentEscrowed) {
            throw new Error('Voucher cumulative amount exceeds channel deposit');
        }

        return {
            ...current,
            acceptedCumulative: cumulativeAmount.toString(),
        };
    });

    return toSessionReceipt(
        payload.channelId,
        updatedChannel?.acceptedCumulative ?? cumulativeAmount.toString(),
        updatedChannel?.spentAmount ?? '0',
        challengeId,
    );
}

async function handleTopUp(
    channelStore: ChannelStore.ChannelStore,
    payload: TopUpPayload,
    parameters: session.Parameters,
    challengeId?: string,
) {
    const current = await channelStore.getChannel(payload.channelId);
    if (!current) {
        throw new Error(`Channel not found: ${payload.channelId}`);
    }

    assertChannelOpen(current);

    if (!payload.transaction.trim()) {
        throw new Error('transaction is required for session topUp');
    }

    const additionalAmount = parseNonNegativeAmount(payload.additionalAmount, 'additionalAmount');

    if (parameters.transactionHandler?.handleTopUp) {
        await parameters.transactionHandler.handleTopUp(
            payload.channelId,
            payload.transaction,
            payload.additionalAmount,
        );
    }

    const updatedChannel = await channelStore.updateChannel(payload.channelId, channel => {
        if (!channel) {
            throw new Error(`Channel not found: ${payload.channelId}`);
        }

        assertChannelOpen(channel);

        const escrowedAmount = parseNonNegativeAmount(channel.escrowedAmount, 'channel.escrowedAmount');
        const nextEscrowed = escrowedAmount + additionalAmount;

        return {
            ...channel,
            closeRequestedAt: 0,
            escrowedAmount: nextEscrowed.toString(),
        };
    });

    return toSessionReceipt(
        payload.channelId,
        updatedChannel?.acceptedCumulative ?? current.acceptedCumulative,
        updatedChannel?.spentAmount ?? current.spentAmount,
        challengeId,
    );
}

async function handleClose(
    channelStore: ChannelStore.ChannelStore,
    payload: ClosePayload,
    parameters: session.Parameters,
    challengeId?: string,
) {
    const channel = await channelStore.getChannel(payload.channelId);
    if (!channel) {
        throw new Error(`Channel not found: ${payload.channelId}`);
    }

    if (channel.status === 'closed') {
        throw new Error(`Channel already closed: ${payload.channelId}`);
    }

    assertChannelOpen(channel);

    // Close voucher is optional. If provided, validate and update accepted cumulative.
    if (payload.voucher) {
        const voucher = parseVoucherFromPayload(payload.voucher);
        assertVoucherNotExpired(voucher, parameters.maxClockSkewSeconds);

        if (voucher.voucher.channelId !== channel.channelId) {
            throw new Error('Voucher channelId mismatch');
        }

        const cumulativeAmount = parseNonNegativeAmount(voucher.voucher.cumulativeAmount, 'voucher.cumulativeAmount');
        const escrowedAmount = parseNonNegativeAmount(channel.escrowedAmount, 'channel.escrowedAmount');

        if (cumulativeAmount > escrowedAmount) {
            throw new Error('Voucher cumulative amount exceeds channel deposit');
        }

        await verifySignedVoucher(voucher, channel, parameters.voucherVerifier);

        await channelStore.updateChannel(payload.channelId, current => {
            if (!current || current.status === 'closed') {
                throw new Error(`Channel already closed: ${payload.channelId}`);
            }

            const currentAccepted = parseNonNegativeAmount(current.acceptedCumulative, 'channel.acceptedCumulative');

            return {
                ...current,
                acceptedCumulative:
                    cumulativeAmount > currentAccepted ? cumulativeAmount.toString() : current.acceptedCumulative,
                status: 'closed',
            };
        });
    } else {
        // Close without voucher: just mark closed.
        await channelStore.updateChannel(payload.channelId, current => {
            if (!current || current.status === 'closed') {
                throw new Error(`Channel already closed: ${payload.channelId}`);
            }

            return {
                ...current,
                status: 'closed',
            };
        });
    }

    return toSessionReceipt(payload.channelId, channel.acceptedCumulative, channel.spentAmount, challengeId);
}

function assertSessionParameters(parameters: session.Parameters) {
    if (!parameters.recipient.trim()) {
        throw new Error('recipient is required');
    }

    if (!parameters.channelProgram.trim()) {
        throw new Error('channelProgram is required');
    }

    if (!parameters.currency.trim()) {
        throw new Error('currency is required');
    }

    if (!parameters.amount.trim()) {
        throw new Error('amount is required');
    }

    if (parameters.currency.toLowerCase() === 'sol') {
        throw new Error(
            'Native SOL is not supported by the mpp-channel program. Provide an SPL token mint address as `currency`.',
        );
    }
}

function assertChannelOpen(channel: ChannelState) {
    if (channel.status === 'closed' || channel.finalized) {
        throw new Error(`Channel is closed: ${channel.channelId}`);
    }
}

function assertVoucherNotExpired(voucher: SignedSessionVoucher, maxClockSkewSeconds = 0) {
    if (!voucher.voucher.expiresAt) {
        return;
    }

    const unixMs = Date.parse(voucher.voucher.expiresAt);
    if (Number.isNaN(unixMs)) {
        throw new Error('voucher.expiresAt must be a valid ISO timestamp');
    }

    if (Date.now() > unixMs + maxClockSkewSeconds * 1000) {
        throw new Error('Voucher has expired');
    }
}

async function verifySignedVoucher(
    voucher: SignedSessionVoucher,
    channel: ChannelState,
    customVerifier?: VoucherVerifier,
) {
    assertSignerAuthorized(voucher, channel);

    if (voucher.signatureType === 'ed25519' || voucher.signatureType === 'swig-session') {
        const valid = await verifyVoucherSignature(voucher);
        if (!valid) {
            throw new Error('Invalid voucher signature');
        }
        return;
    }

    if (!customVerifier) {
        throw new Error(`Unsupported voucher signatureType without custom verifier: ${String(voucher.signatureType)}`);
    }

    const valid = await customVerifier.verify(voucher, channel);
    if (!valid) {
        throw new Error('Invalid voucher signature');
    }
}

function assertSignerAuthorized(voucher: SignedSessionVoucher, channel: ChannelState) {
    // authorizedSigner is established from the open voucher's signer. For standard channels
    // it equals the payer; for delegated channels (e.g. Swig session keys) it is the delegated
    // key. There is no payer fallback — authorizedSigner is the definitive authority.
    if (voucher.signer !== channel.authorizedSigner) {
        throw new Error(`Voucher signer ${voucher.signer} does not match authorized signer ${channel.authorizedSigner}`);
    }
}

function parseNonNegativeAmount(value: string, field: string): bigint {
    let parsed: bigint;
    try {
        parsed = BigInt(value);
    } catch {
        throw new Error(`${field} must be a valid integer string`);
    }

    if (parsed < 0n) {
        throw new Error(`${field} must be non-negative`);
    }

    return parsed;
}

function toSessionReceipt(
    reference: string,
    _acceptedCumulative: string,
    _spent: string,
    challengeId?: string,
): Receipt.Receipt {
    return Receipt.from({
        method: 'solana',
        ...(challengeId ? { externalId: challengeId } : {}),
        reference,
        status: 'success',
        timestamp: new Date().toISOString(),
    });
}

export declare namespace session {
    type Parameters = {
        /** Price per unit in token base units. */
        amount: string;
        /** Channel program address. */
        channelProgram: string;
        /** Currency identifier: "sol" or SPL mint address. */
        currency: string;
        /** Token decimals (required for SPL tokens). */
        decimals?: number;
        /** If true, server pays transaction fees. */
        feePayer?: boolean;
        /** Server's fee payer public key. Required when feePayer is true. */
        feePayerKey?: string;
        /** Grace period in seconds for forced close. */
        gracePeriodSeconds?: number;
        /** Maximum clock skew tolerance in seconds for voucher expiry checks. */
        maxClockSkewSeconds?: number;
        /** Minimum voucher delta the server will accept. */
        minVoucherDelta?: string;
        /** Solana network. Defaults to mainnet-beta. */
        network?: 'devnet' | 'localnet' | 'mainnet-beta' | 'surfnet' | (string & {});
        /** Base58-encoded recipient (payee) public key. */
        recipient: string;
        /** RPC URL override. */
        rpcUrl?: string;
        /** Persistence store. Defaults to in-memory. */
        store?: Store.Store;
        /** Suggested initial channel deposit. */
        suggestedDeposit?: string;
        /** Handlers for inspecting and broadcasting partially-signed transactions. */
        transactionHandler?: TransactionHandler;
        /** Suggested TTL for the session in seconds. */
        ttlSeconds?: number;
        /** Unit type for pricing (e.g., "request", "token", "byte"). */
        unitType?: string;
        /** Custom voucher verifier for non-standard signature types. */
        voucherVerifier?: VoucherVerifier;
    };
}
