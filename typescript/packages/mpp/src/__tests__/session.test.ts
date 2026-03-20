import { test, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import { Store } from 'mppx/server';
import { session } from '../server/Session.js';
import { signVoucher } from '../session/Voucher.js';
import * as ChannelStore from '../session/ChannelStore.js';
import type { AuthorizationMode, ChannelState, SignedSessionVoucher } from '../session/Types.js';

const RECIPIENT = '9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ';
const CHANNEL_PROGRAM = 'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB';
const NETWORK = 'devnet';

type ChallengeRequest = {
    recipient: string;
    network?: string;
    asset: { kind: 'sol' | 'spl'; mint?: string; decimals: number; symbol?: string };
    channelProgram: string;
    pricing?: { unit: string; amountPerUnit: string; meter: string; minDebit?: string };
    sessionDefaults?: {
        suggestedDeposit?: string;
        ttlSeconds?: number;
        settleInterval?: { kind: string; minIncrement?: string; seconds?: number };
        closeBehavior?: 'server_may_finalize' | 'payer_must_close';
    };
    verifier?: {
        acceptAuthorizationModes?: Array<'swig_session' | 'regular_budget' | 'regular_unbounded'>;
        maxClockSkewSeconds?: number;
    };
};

type OpenCredentialOptions = {
    channelId: string;
    serverNonce?: string;
    depositAmount?: string;
    cumulativeAmount?: string;
    sequence?: number;
    authorizationMode?: AuthorizationMode;
    challengeId?: string;
    challengeRequestOverrides?: Partial<ChallengeRequest>;
    voucher?: SignedSessionVoucher;
};

type UpdateCredentialOptions = {
    channelId: string;
    serverNonce: string;
    cumulativeAmount: string;
    sequence: number;
    challengeId?: string;
    challengeRequestOverrides?: Partial<ChallengeRequest>;
    voucher?: SignedSessionVoucher;
};

type CloseCredentialOptions = {
    channelId: string;
    serverNonce: string;
    cumulativeAmount: string;
    sequence: number;
    closeTx?: string;
    challengeId?: string;
    challengeRequestOverrides?: Partial<ChallengeRequest>;
    voucher?: SignedSessionVoucher;
};

type TopupCredentialOptions = {
    channelId: string;
    additionalAmount: string;
    topupTx: string;
    challengeId?: string;
    challengeRequestOverrides?: Partial<ChallengeRequest>;
};

let store: Store.Store;
let payerSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;

beforeEach(async () => {
    store = Store.memory();
    payerSigner = await generateKeyPairSigner();
});

afterEach(() => {
    store = Store.memory();
});

test('session() throws when asset is spl without mint', () => {
    expect(() =>
        session({
            recipient: RECIPIENT,
            network: NETWORK,
            asset: { kind: 'spl', decimals: 6 },
            channelProgram: CHANNEL_PROGRAM,
            store,
        }),
    ).toThrow(/asset\.mint is required/);
});

test('request() populates recipient/network/asset/channel metadata', async () => {
    const method = session({
        recipient: RECIPIENT,
        network: NETWORK,
        asset: { kind: 'sol', decimals: 9, symbol: 'sol' },
        channelProgram: CHANNEL_PROGRAM,
        pricing: {
            unit: 'request',
            amountPerUnit: '10',
            meter: 'api_calls',
            minDebit: '5',
        },
        sessionDefaults: {
            suggestedDeposit: '1000',
            ttlSeconds: 60,
        },
        verifier: {
            acceptAuthorizationModes: ['regular_unbounded'],
            maxClockSkewSeconds: 10,
        },
        store,
    });

    const request = await method.request!({
        credential: null,
        request: {
            recipient: '',
            network: undefined,
            asset: { kind: 'sol', decimals: 9 },
            channelProgram: '',
        },
    });

    expect(request.recipient).toBe(RECIPIENT);
    expect(request.network).toBe(NETWORK);
    expect(request.asset).toEqual({ kind: 'sol', decimals: 9, symbol: 'sol' });
    expect(request.channelProgram).toBe(CHANNEL_PROGRAM);
    expect(request.pricing).toEqual({
        unit: 'request',
        amountPerUnit: '10',
        meter: 'api_calls',
        minDebit: '5',
    });
    expect(request.sessionDefaults).toEqual({
        suggestedDeposit: '1000',
        ttlSeconds: 60,
    });
    expect(request.verifier).toEqual({
        acceptAuthorizationModes: ['regular_unbounded'],
        maxClockSkewSeconds: 10,
    });
});

test('request() returns challenge request when credential is present', async () => {
    const method = session({
        recipient: RECIPIENT,
        network: NETWORK,
        asset: { kind: 'sol', decimals: 9 },
        channelProgram: CHANNEL_PROGRAM,
        store,
    });

    const challengeRequest = buildChallengeRequest({
        pricing: { unit: 'request', amountPerUnit: '1', meter: 'api' },
    });

    const request = await method.request!({
        credential: buildCredentialWithChallengeRequest(challengeRequest),
        request: {
            recipient: '',
            network: undefined,
            asset: { kind: 'sol', decimals: 9 },
            channelProgram: '',
        },
    });

    expect(request).toEqual(challengeRequest);
});

test('open flow creates channel state and returns success receipt', async () => {
    const channelId = `channel-open-${crypto.randomUUID()}`;
    const method = createMethod();
    const credential = await buildOpenCredential({
        channelId,
        depositAmount: '1000',
        cumulativeAmount: '0',
        sequence: 0,
        challengeId: 'challenge-open',
    });

    const receipt = await method.verify({
        credential,
        request: buildChallengeRequest(),
    });

    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe(channelId);

    const channel = await getChannel(channelId);
    expect(channel).toBeTruthy();
    expect(channel!.status).toBe('open');
    expect(channel!.escrowedAmount).toBe('1000');
    expect(channel!.lastAuthorizedAmount).toBe('0');
    expect(channel!.lastSequence).toBe(0);
    expect(channel!.recipient).toBe(RECIPIENT);

    const response = await method.respond!({
        credential,
        request: buildChallengeRequest(),
        receipt,
        input: new Request('http://localhost'),
    });
    expect(response).toBeUndefined();
});

test('update flow enforces monotonic cumulative amount and sequence', async () => {
    const channelId = `channel-update-${crypto.randomUUID()}`;
    const serverNonce = crypto.randomUUID();
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            serverNonce,
            depositAmount: '1000',
            cumulativeAmount: '0',
            sequence: 0,
        }),
        request: buildChallengeRequest(),
    });

    const firstUpdate = await method.verify({
        credential: await buildUpdateCredential({
            channelId,
            serverNonce,
            cumulativeAmount: '300',
            sequence: 1,
            challengeId: 'challenge-update-1',
        }),
        request: buildChallengeRequest(),
    });

    expect(firstUpdate.status).toBe('success');
    expect(firstUpdate.reference).toBe(channelId);

    const channelAfterFirst = await getChannel(channelId);
    expect(channelAfterFirst).toBeTruthy();
    expect(channelAfterFirst!.lastAuthorizedAmount).toBe('300');
    expect(channelAfterFirst!.lastSequence).toBe(1);

    const replayCredential = await buildUpdateCredential({
        channelId,
        serverNonce,
        cumulativeAmount: '350',
        sequence: 1,
    });

    await expect(
        method.verify({
            credential: replayCredential,
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/replay detected/);

    const nonMonotonicCredential = await buildUpdateCredential({
        channelId,
        serverNonce,
        cumulativeAmount: '250',
        sequence: 2,
    });

    await expect(
        method.verify({
            credential: nonMonotonicCredential,
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/monotonically non-decreasing/);
});

test('topup flow updates escrowed deposit and respond() returns 204', async () => {
    const channelId = `channel-topup-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            depositAmount: '1000',
            cumulativeAmount: '0',
            sequence: 0,
        }),
        request: buildChallengeRequest(),
    });

    const topupCredential = buildTopupCredential({
        channelId,
        additionalAmount: '250',
        topupTx: 'topup-transaction',
        challengeId: 'challenge-topup',
    });

    const receipt = await method.verify({
        credential: topupCredential,
        request: buildChallengeRequest(),
    });

    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe(channelId);

    const channel = await getChannel(channelId);
    expect(channel).toBeTruthy();
    expect(channel!.escrowedAmount).toBe('1250');

    const response = await method.respond!({
        credential: topupCredential,
        request: buildChallengeRequest(),
        receipt,
        input: new Request('http://localhost'),
    });
    expect(response?.status).toBe(204);
});

test('close flow marks channel as closed and respond() returns 204', async () => {
    const channelId = `channel-close-${crypto.randomUUID()}`;
    const serverNonce = crypto.randomUUID();
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            serverNonce,
            depositAmount: '1000',
            cumulativeAmount: '0',
            sequence: 0,
        }),
        request: buildChallengeRequest(),
    });

    await method.verify({
        credential: await buildUpdateCredential({
            channelId,
            serverNonce,
            cumulativeAmount: '400',
            sequence: 1,
        }),
        request: buildChallengeRequest(),
    });

    const closeCredential = await buildCloseCredential({
        channelId,
        serverNonce,
        cumulativeAmount: '450',
        sequence: 2,
        challengeId: 'challenge-close',
    });

    const receipt = await method.verify({
        credential: closeCredential,
        request: buildChallengeRequest(),
    });

    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe(channelId);

    const channel = await getChannel(channelId);
    expect(channel).toBeTruthy();
    expect(channel!.status).toBe('closed');
    expect(channel!.lastAuthorizedAmount).toBe('450');
    expect(channel!.lastSequence).toBe(2);

    const response = await method.respond!({
        credential: closeCredential,
        request: buildChallengeRequest(),
        receipt,
        input: new Request('http://localhost'),
    });
    expect(response?.status).toBe(204);
});

test('rejects invalid voucher signature', async () => {
    const channelId = `channel-invalid-signature-${crypto.randomUUID()}`;
    const method = createMethod();

    const validVoucher = await buildSignedVoucher({
        channelId,
        cumulativeAmount: '0',
        sequence: 0,
        serverNonce: crypto.randomUUID(),
    });

    const invalidVoucher: SignedSessionVoucher = {
        ...validVoucher,
        signature: `${validVoucher.signature}-tampered`,
    };

    const invalidOpenCredential = await buildOpenCredential({
        channelId,
        depositAmount: '1000',
        voucher: invalidVoucher,
    });

    await expect(
        method.verify({
            credential: invalidOpenCredential,
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/Invalid voucher signature/);
});

test('accepts swig-session vouchers signed by delegated session key', async () => {
    const channelId = `channel-swig-valid-${crypto.randomUUID()}`;
    const serverNonce = crypto.randomUUID();
    const method = createMethod();
    const delegatedSessionSigner = await generateKeyPairSigner();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            serverNonce,
            depositAmount: '1000',
            cumulativeAmount: '0',
            sequence: 0,
            authorizationMode: 'swig_session',
            voucher: await buildSignedVoucher({
                channelId,
                serverNonce,
                cumulativeAmount: '0',
                sequence: 0,
                signer: delegatedSessionSigner,
                signatureType: 'swig-session',
            }),
        }),
        request: buildChallengeRequest(),
    });

    const receipt = await method.verify({
        credential: await buildUpdateCredential({
            channelId,
            serverNonce,
            cumulativeAmount: '250',
            sequence: 1,
            voucher: await buildSignedVoucher({
                channelId,
                serverNonce,
                cumulativeAmount: '250',
                sequence: 1,
                signer: delegatedSessionSigner,
                signatureType: 'swig-session',
            }),
        }),
        request: buildChallengeRequest(),
    });

    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe(channelId);
});

test('rejects swig-session voucher signed by wrong signer', async () => {
    const channelId = `channel-swig-wrong-signer-${crypto.randomUUID()}`;
    const serverNonce = crypto.randomUUID();
    const method = createMethod();
    const delegatedSessionSigner = await generateKeyPairSigner();
    const wrongSigner = await generateKeyPairSigner();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            serverNonce,
            depositAmount: '1000',
            cumulativeAmount: '0',
            sequence: 0,
            authorizationMode: 'swig_session',
            voucher: await buildSignedVoucher({
                channelId,
                serverNonce,
                cumulativeAmount: '0',
                sequence: 0,
                signer: delegatedSessionSigner,
                signatureType: 'swig-session',
            }),
        }),
        request: buildChallengeRequest(),
    });

    const wrongSignerCredential = await buildUpdateCredential({
        channelId,
        serverNonce,
        cumulativeAmount: '250',
        sequence: 1,
        voucher: await buildSignedVoucher({
            channelId,
            serverNonce,
            cumulativeAmount: '250',
            sequence: 1,
            signer: wrongSigner,
            signatureType: 'swig-session',
        }),
    });

    await expect(
        method.verify({
            credential: wrongSignerCredential,
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/delegated session key/);
});

test('open flow supports configurable transactionVerifier callbacks', async () => {
    const channelId = `channel-open-verified-${crypto.randomUUID()}`;
    const method = createMethod({
        transactionVerifier: {
            verifyOpen: async () => {
                throw new Error('open transaction rejected by verifier');
            },
        },
    });

    const credential = await buildOpenCredential({
        channelId,
        depositAmount: '1000',
        cumulativeAmount: '0',
        sequence: 0,
    });

    await expect(
        method.verify({
            credential,
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/open transaction rejected by verifier/);
});

test('close flow supports configurable transactionVerifier callbacks', async () => {
    const channelId = `channel-close-verified-${crypto.randomUUID()}`;
    const serverNonce = crypto.randomUUID();

    let observedCloseTx: string | null = null;
    let observedFinalCumulative: string | null = null;

    const method = createMethod({
        transactionVerifier: {
            verifyClose: async (_channelId, closeTx, finalCumulativeAmount) => {
                observedCloseTx = closeTx;
                observedFinalCumulative = finalCumulativeAmount;
            },
        },
    });

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            serverNonce,
            depositAmount: '1000',
            cumulativeAmount: '0',
            sequence: 0,
        }),
        request: buildChallengeRequest(),
    });

    await method.verify({
        credential: await buildUpdateCredential({
            channelId,
            serverNonce,
            cumulativeAmount: '400',
            sequence: 1,
        }),
        request: buildChallengeRequest(),
    });

    const receipt = await method.verify({
        credential: await buildCloseCredential({
            channelId,
            serverNonce,
            cumulativeAmount: '450',
            sequence: 2,
            closeTx: 'close-transaction-signature',
        }),
        request: buildChallengeRequest(),
    });

    expect(receipt.reference).toBe('close-transaction-signature');
    expect(observedCloseTx).toBe('close-transaction-signature');
    expect(observedFinalCumulative).toBe('450');
});

test('close flow requires closeTx when verifyClose callback is configured', async () => {
    const channelId = `channel-close-missing-tx-${crypto.randomUUID()}`;
    const serverNonce = crypto.randomUUID();

    const method = createMethod({
        transactionVerifier: {
            verifyClose: async () => undefined,
        },
    });

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            serverNonce,
            depositAmount: '1000',
            cumulativeAmount: '0',
            sequence: 0,
        }),
        request: buildChallengeRequest(),
    });

    await method.verify({
        credential: await buildUpdateCredential({
            channelId,
            serverNonce,
            cumulativeAmount: '400',
            sequence: 1,
        }),
        request: buildChallengeRequest(),
    });

    await expect(
        method.verify({
            credential: await buildCloseCredential({
                channelId,
                serverNonce,
                cumulativeAmount: '450',
                sequence: 2,
            }),
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/closeTx is required/);
});

test('rejects update when cumulative amount exceeds deposit', async () => {
    const channelId = `channel-exceed-deposit-${crypto.randomUUID()}`;
    const serverNonce = crypto.randomUUID();
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            serverNonce,
            depositAmount: '100',
            cumulativeAmount: '0',
            sequence: 0,
        }),
        request: buildChallengeRequest(),
    });

    const exceedsDepositCredential = await buildUpdateCredential({
        channelId,
        serverNonce,
        cumulativeAmount: '101',
        sequence: 1,
    });

    await expect(
        method.verify({
            credential: exceedsDepositCredential,
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/exceeds channel deposit/);
});

test('rejects replay attempts using duplicate sequence', async () => {
    const channelId = `channel-replay-${crypto.randomUUID()}`;
    const serverNonce = crypto.randomUUID();
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            serverNonce,
            depositAmount: '1000',
            cumulativeAmount: '0',
            sequence: 0,
        }),
        request: buildChallengeRequest(),
    });

    await method.verify({
        credential: await buildUpdateCredential({
            channelId,
            serverNonce,
            cumulativeAmount: '200',
            sequence: 1,
        }),
        request: buildChallengeRequest(),
    });

    const replayUpdateCredential = await buildUpdateCredential({
        channelId,
        serverNonce,
        cumulativeAmount: '250',
        sequence: 1,
    });

    await expect(
        method.verify({
            credential: replayUpdateCredential,
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/replay detected/);
});

test('rejects voucher signed by unauthorized signer', async () => {
    const channelId = `channel-rogue-signer-${crypto.randomUUID()}`;
    const serverNonce = crypto.randomUUID();
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            serverNonce,
            depositAmount: '1000',
            cumulativeAmount: '0',
            sequence: 0,
        }),
        request: buildChallengeRequest(),
    });

    const rogueSigner = await generateKeyPairSigner();
    const rogueVoucher = await signVoucher(rogueSigner, {
        channelId,
        payer: payerSigner.address,
        recipient: RECIPIENT,
        cumulativeAmount: '200',
        sequence: 1,
        meter: 'api_calls',
        units: '1',
        serverNonce,
        chainId: `solana:${NETWORK}`,
        channelProgram: CHANNEL_PROGRAM,
    });

    const rogueCredential = await buildUpdateCredential({
        channelId,
        serverNonce,
        cumulativeAmount: '200',
        sequence: 1,
        voucher: rogueVoucher,
    });

    await expect(
        method.verify({
            credential: rogueCredential,
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/does not match channel payer/);
});

test('rejects actions after channel is closed', async () => {
    const channelId = `channel-closed-${crypto.randomUUID()}`;
    const serverNonce = crypto.randomUUID();
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            serverNonce,
            depositAmount: '500',
            cumulativeAmount: '0',
            sequence: 0,
        }),
        request: buildChallengeRequest(),
    });

    await method.verify({
        credential: await buildCloseCredential({
            channelId,
            serverNonce,
            cumulativeAmount: '100',
            sequence: 1,
        }),
        request: buildChallengeRequest(),
    });

    const updateAfterCloseCredential = await buildUpdateCredential({
        channelId,
        serverNonce,
        cumulativeAmount: '150',
        sequence: 2,
    });

    await expect(
        method.verify({
            credential: updateAfterCloseCredential,
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/closed/);
});

function createMethod(overrides: Partial<session.Parameters> = {}) {
    return session({
        recipient: RECIPIENT,
        network: NETWORK,
        asset: { kind: 'sol', decimals: 9 },
        channelProgram: CHANNEL_PROGRAM,
        store,
        ...overrides,
    });
}

function buildChallengeRequest(overrides: Partial<ChallengeRequest> = {}): ChallengeRequest {
    return {
        recipient: RECIPIENT,
        network: NETWORK,
        asset: { kind: 'sol', decimals: 9 },
        channelProgram: CHANNEL_PROGRAM,
        ...overrides,
    };
}

function buildCredentialWithChallengeRequest(request: ChallengeRequest): any {
    return { challenge: { request } };
}

async function buildSignedVoucher(input: {
    channelId: string;
    serverNonce: string;
    cumulativeAmount: string;
    sequence: number;
    signer?: Awaited<ReturnType<typeof generateKeyPairSigner>>;
    signatureType?: SignedSessionVoucher['signatureType'];
}): Promise<SignedSessionVoucher> {
    const signer = input.signer ?? payerSigner;

    const voucher = await signVoucher(signer, {
        channelId: input.channelId,
        payer: payerSigner.address,
        recipient: RECIPIENT,
        cumulativeAmount: input.cumulativeAmount,
        sequence: input.sequence,
        meter: 'api_calls',
        units: '1',
        serverNonce: input.serverNonce,
        chainId: `solana:${NETWORK}`,
        channelProgram: CHANNEL_PROGRAM,
    });

    if (input.signatureType === undefined || input.signatureType === voucher.signatureType) {
        return voucher;
    }

    return {
        ...voucher,
        signatureType: input.signatureType,
    };
}

async function buildOpenCredential(options: OpenCredentialOptions): Promise<any> {
    const serverNonce = options.serverNonce ?? crypto.randomUUID();
    const voucher =
        options.voucher ??
        (await buildSignedVoucher({
            channelId: options.channelId,
            serverNonce,
            cumulativeAmount: options.cumulativeAmount ?? '0',
            sequence: options.sequence ?? 0,
        }));

    return {
        payload: {
            action: 'open',
            channelId: options.channelId,
            payer: payerSigner.address,
            authorizationMode: options.authorizationMode ?? 'regular_unbounded',
            depositAmount: options.depositAmount ?? '1000',
            openTx: 'open-transaction',
            voucher,
        },
        challenge: {
            id: options.challengeId ?? 'challenge-open',
            request: buildChallengeRequest(options.challengeRequestOverrides),
        },
    };
}

async function buildUpdateCredential(options: UpdateCredentialOptions): Promise<any> {
    const voucher =
        options.voucher ??
        (await buildSignedVoucher({
            channelId: options.channelId,
            serverNonce: options.serverNonce,
            cumulativeAmount: options.cumulativeAmount,
            sequence: options.sequence,
        }));

    return {
        payload: {
            action: 'update',
            channelId: options.channelId,
            voucher,
        },
        challenge: {
            id: options.challengeId ?? 'challenge-update',
            request: buildChallengeRequest(options.challengeRequestOverrides),
        },
    };
}

async function buildCloseCredential(options: CloseCredentialOptions): Promise<any> {
    const voucher =
        options.voucher ??
        (await buildSignedVoucher({
            channelId: options.channelId,
            serverNonce: options.serverNonce,
            cumulativeAmount: options.cumulativeAmount,
            sequence: options.sequence,
        }));

    return {
        payload: {
            action: 'close',
            channelId: options.channelId,
            ...(options.closeTx ? { closeTx: options.closeTx } : {}),
            voucher,
        },
        challenge: {
            id: options.challengeId ?? 'challenge-close',
            request: buildChallengeRequest(options.challengeRequestOverrides),
        },
    };
}

function buildTopupCredential(options: TopupCredentialOptions): any {
    return {
        payload: {
            action: 'topup',
            channelId: options.channelId,
            additionalAmount: options.additionalAmount,
            topupTx: options.topupTx,
        },
        challenge: {
            id: options.challengeId ?? 'challenge-topup',
            request: buildChallengeRequest(options.challengeRequestOverrides),
        },
    };
}

async function getChannel(channelId: string): Promise<ChannelState | null> {
    const channelStore = ChannelStore.fromStore(store);
    return await channelStore.getChannel(channelId);
}
