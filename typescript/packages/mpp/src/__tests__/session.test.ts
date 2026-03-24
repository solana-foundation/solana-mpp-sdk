import { test, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import { Store } from 'mppx/server';
import { session } from '../server/Session.js';
import { signVoucher } from '../session/Voucher.js';
import * as ChannelStore from '../session/ChannelStore.js';
import type { ChannelState, SignedSessionVoucher } from '../session/Types.js';

const RECIPIENT = '9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ';
const CHANNEL_PROGRAM = 'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB';
const TOKEN_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mint (mock SPL address for tests)

type ChallengeRequest = {
    amount: string;
    currency: string;
    recipient: string;
    methodDetails: {
        channelProgram: string;
        network?: string;
        decimals?: number;
    };
    suggestedDeposit?: string;
    unitType?: string;
};

type OpenCredentialOptions = {
    channelId: string;
    depositAmount?: string;
    cumulativeAmount?: string;
    challengeId?: string;
    voucher?: SignedSessionVoucher;
};

type VoucherCredentialOptions = {
    channelId: string;
    cumulativeAmount: string;
    challengeId?: string;
    voucher?: SignedSessionVoucher;
};

type CloseCredentialOptions = {
    channelId: string;
    cumulativeAmount?: string;
    challengeId?: string;
    voucher?: SignedSessionVoucher;
};

type TopUpCredentialOptions = {
    channelId: string;
    additionalAmount: string;
    transaction: string;
    challengeId?: string;
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

test('session() throws when currency is empty', () => {
    expect(() =>
        session({
            recipient: RECIPIENT,
            currency: '',
            amount: '10',
            channelProgram: CHANNEL_PROGRAM,
            store,
        }),
    ).toThrow(/currency is required/);
});

test('request() populates recipient/currency/amount/channelProgram metadata', async () => {
    const method = session({
        recipient: RECIPIENT,
        currency: TOKEN_MINT,
        amount: '10',
        channelProgram: CHANNEL_PROGRAM,
        suggestedDeposit: '1000',
        unitType: 'request',
        store,
    });

    const request = await method.request!({
        credential: null,
        request: {
            amount: '',
            currency: '',
            recipient: '',
            methodDetails: { channelProgram: '' },
        },
    });

    expect(request.recipient).toBe(RECIPIENT);
    expect(request.currency).toBe(TOKEN_MINT);
    expect(request.amount).toBe('10');
    expect(request.methodDetails.channelProgram).toBe(CHANNEL_PROGRAM);
    expect(request.suggestedDeposit).toBe('1000');
    expect(request.unitType).toBe('request');
});

test('open flow creates channel state and returns success receipt', async () => {
    const channelId = `channel-open-${crypto.randomUUID()}`;
    const method = createMethod();
    const credential = await buildOpenCredential({
        channelId,
        depositAmount: '1000',
        cumulativeAmount: '0',
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
    expect(channel!.acceptedCumulative).toBe('0');
    expect(channel!.payee).toBe(RECIPIENT);

    const response = await method.respond!({
        credential,
        request: buildChallengeRequest(),
        receipt,
        input: new Request('http://localhost'),
    });
    expect(response).toBeUndefined();
});

test('voucher flow enforces cumulative monotonicity', async () => {
    const channelId = `channel-voucher-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            depositAmount: '1000',
            cumulativeAmount: '0',
        }),
        request: buildChallengeRequest(),
    });

    const firstVoucher = await method.verify({
        credential: await buildVoucherCredential({
            channelId,
            cumulativeAmount: '300',
            challengeId: 'challenge-voucher-1',
        }),
        request: buildChallengeRequest(),
    });

    expect(firstVoucher.status).toBe('success');

    const channelAfterFirst = await getChannel(channelId);
    expect(channelAfterFirst!.acceptedCumulative).toBe('300');
});

test('voucher is idempotent for same cumulative amount and rejects lower', async () => {
    const channelId = `channel-idempotent-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({ channelId, depositAmount: '1000', cumulativeAmount: '0' }),
        request: buildChallengeRequest(),
    });

    await method.verify({
        credential: await buildVoucherCredential({ channelId, cumulativeAmount: '300' }),
        request: buildChallengeRequest(),
    });

    // Same amount: idempotent success, no state change.
    const idempotentResult = await method.verify({
        credential: await buildVoucherCredential({ channelId, cumulativeAmount: '300' }),
        request: buildChallengeRequest(),
    });
    expect(idempotentResult.status).toBe('success');
    const channelAfter = await getChannel(channelId);
    expect(channelAfter!.acceptedCumulative).toBe('300');

    // Lower amount: rejected — cumulative must not decrease.
    await expect(
        method.verify({
            credential: await buildVoucherCredential({ channelId, cumulativeAmount: '200' }),
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/cumulative amount must not decrease/);
});

test('rejects voucher on channel with pending forced close', async () => {
    const channelId = `channel-pending-close-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({ channelId, depositAmount: '1000', cumulativeAmount: '0' }),
        request: buildChallengeRequest(),
    });

    // Simulate a pending forced close.
    const channelStore = ChannelStore.fromStore(store);
    await channelStore.updateChannel(channelId, current => {
        if (!current) return null;
        return { ...current, closeRequestedAt: Math.floor(Date.now() / 1000) };
    });

    await expect(
        method.verify({
            credential: await buildVoucherCredential({ channelId, cumulativeAmount: '100' }),
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/pending forced close/);
});

test('topUp flow updates escrowed deposit and respond() returns 204', async () => {
    const channelId = `channel-topup-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({ channelId, depositAmount: '1000', cumulativeAmount: '0' }),
        request: buildChallengeRequest(),
    });

    const topUpCredential = buildTopUpCredential({
        channelId,
        additionalAmount: '250',
        transaction: 'dHJhbnNhY3Rpb24tYnl0ZXM=',
        challengeId: 'challenge-topup',
    });

    const receipt = await method.verify({
        credential: topUpCredential,
        request: buildChallengeRequest(),
    });

    expect(receipt.status).toBe('success');

    const channel = await getChannel(channelId);
    expect(channel!.escrowedAmount).toBe('1250');

    const response = await method.respond!({
        credential: topUpCredential,
        request: buildChallengeRequest(),
        receipt,
        input: new Request('http://localhost'),
    });
    expect(response?.status).toBe(204);
});

test('topUp resets closeRequestedAt', async () => {
    const channelId = `channel-topup-reset-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({ channelId, depositAmount: '1000', cumulativeAmount: '0' }),
        request: buildChallengeRequest(),
    });

    // Simulate a pending close by manually setting closeRequestedAt.
    const channelStore = ChannelStore.fromStore(store);
    await channelStore.updateChannel(channelId, current => {
        if (!current) return null;
        return { ...current, closeRequestedAt: Math.floor(Date.now() / 1000) };
    });

    await method.verify({
        credential: buildTopUpCredential({
            channelId,
            additionalAmount: '500',
            transaction: 'dHJhbnNhY3Rpb24tYnl0ZXM=',
        }),
        request: buildChallengeRequest(),
    });

    const channel = await getChannel(channelId);
    expect(channel!.closeRequestedAt).toBe(0);
});

test('close flow marks channel as closed and respond() returns 204', async () => {
    const channelId = `channel-close-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({ channelId, depositAmount: '1000', cumulativeAmount: '0' }),
        request: buildChallengeRequest(),
    });

    await method.verify({
        credential: await buildVoucherCredential({ channelId, cumulativeAmount: '400' }),
        request: buildChallengeRequest(),
    });

    const closeCredential = await buildCloseCredential({
        channelId,
        cumulativeAmount: '450',
        challengeId: 'challenge-close',
    });

    const receipt = await method.verify({
        credential: closeCredential,
        request: buildChallengeRequest(),
    });

    expect(receipt.status).toBe('success');

    const channel = await getChannel(channelId);
    expect(channel!.status).toBe('closed');
    expect(channel!.acceptedCumulative).toBe('450');

    const response = await method.respond!({
        credential: closeCredential,
        request: buildChallengeRequest(),
        receipt,
        input: new Request('http://localhost'),
    });
    expect(response?.status).toBe(204);
});

test('close without voucher marks channel closed', async () => {
    const channelId = `channel-close-no-voucher-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({ channelId, depositAmount: '1000', cumulativeAmount: '0' }),
        request: buildChallengeRequest(),
    });

    const closeCredential = {
        payload: { action: 'close' as const, channelId },
        challenge: { id: 'challenge-close', request: buildChallengeRequest() },
    } as any;

    const receipt = await method.verify({
        credential: closeCredential,
        request: buildChallengeRequest(),
    });

    expect(receipt.status).toBe('success');
    const channel = await getChannel(channelId);
    expect(channel!.status).toBe('closed');
});

test('rejects invalid voucher signature', async () => {
    const channelId = `channel-invalid-sig-${crypto.randomUUID()}`;
    const method = createMethod();

    const validVoucher = await buildSignedVoucher({
        channelId,
        cumulativeAmount: '0',
    });

    const invalidVoucher: SignedSessionVoucher = {
        ...validVoucher,
        signature: `${validVoucher.signature}-tampered`,
    };

    const credential = await buildOpenCredential({
        channelId,
        depositAmount: '1000',
        voucher: invalidVoucher,
    });

    await expect(method.verify({ credential, request: buildChallengeRequest() })).rejects.toThrow(
        /Invalid voucher signature/,
    );
});

test('rejects voucher signed by unauthorized signer', async () => {
    const channelId = `channel-rogue-signer-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({ channelId, depositAmount: '1000', cumulativeAmount: '0' }),
        request: buildChallengeRequest(),
    });

    const rogueSigner = await generateKeyPairSigner();
    const rogueVoucher = await signVoucher(rogueSigner, {
        channelId,
        cumulativeAmount: '200',
    });

    await expect(
        method.verify({
            credential: await buildVoucherCredential({
                channelId,
                cumulativeAmount: '200',
                voucher: rogueVoucher,
            }),
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/does not match authorized signer/);
});

test('rejects update when cumulative amount exceeds deposit', async () => {
    const channelId = `channel-exceed-deposit-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({ channelId, depositAmount: '100', cumulativeAmount: '0' }),
        request: buildChallengeRequest(),
    });

    await expect(
        method.verify({
            credential: await buildVoucherCredential({ channelId, cumulativeAmount: '101' }),
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/exceeds channel deposit/);
});

test('rejects actions after channel is closed', async () => {
    const channelId = `channel-closed-${crypto.randomUUID()}`;
    const method = createMethod();

    await method.verify({
        credential: await buildOpenCredential({ channelId, depositAmount: '500', cumulativeAmount: '0' }),
        request: buildChallengeRequest(),
    });

    await method.verify({
        credential: await buildCloseCredential({ channelId, cumulativeAmount: '100' }),
        request: buildChallengeRequest(),
    });

    await expect(
        method.verify({
            credential: await buildVoucherCredential({ channelId, cumulativeAmount: '150' }),
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/closed/);
});

test('request() returns challenge request when credential is present', async () => {
    const method = createMethod();

    const challengeRequest = buildChallengeRequest();

    const request = await method.request!({
        credential: { challenge: { request: challengeRequest } } as any,
        request: {
            amount: '',
            currency: '',
            recipient: '',
            methodDetails: { channelProgram: '' },
        },
    });

    expect(request).toEqual(challengeRequest);
});

test('accepts swig-session vouchers signed by delegated session key', async () => {
    const channelId = `channel-swig-valid-${crypto.randomUUID()}`;
    const method = createMethod();
    const delegatedSessionSigner = await generateKeyPairSigner();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            depositAmount: '1000',
            cumulativeAmount: '0',
            voucher: await buildSignedVoucher({
                channelId,
                cumulativeAmount: '0',
                signer: delegatedSessionSigner,
                signatureType: 'swig-session',
            }),
        }),
        request: buildChallengeRequest(),
    });

    const receipt = await method.verify({
        credential: await buildVoucherCredential({
            channelId,
            cumulativeAmount: '250',
            voucher: await buildSignedVoucher({
                channelId,
                cumulativeAmount: '250',
                signer: delegatedSessionSigner,
                signatureType: 'swig-session',
            }),
        }),
        request: buildChallengeRequest(),
    });

    expect(receipt.status).toBe('success');
});

test('rejects swig-session voucher signed by wrong signer', async () => {
    const channelId = `channel-swig-wrong-signer-${crypto.randomUUID()}`;
    const method = createMethod();
    const delegatedSessionSigner = await generateKeyPairSigner();
    const wrongSigner = await generateKeyPairSigner();

    await method.verify({
        credential: await buildOpenCredential({
            channelId,
            depositAmount: '1000',
            cumulativeAmount: '0',
            voucher: await buildSignedVoucher({
                channelId,
                cumulativeAmount: '0',
                signer: delegatedSessionSigner,
                signatureType: 'swig-session',
            }),
        }),
        request: buildChallengeRequest(),
    });

    await expect(
        method.verify({
            credential: await buildVoucherCredential({
                channelId,
                cumulativeAmount: '250',
                voucher: await buildSignedVoucher({
                    channelId,
                    cumulativeAmount: '250',
                    signer: wrongSigner,
                    signatureType: 'swig-session',
                }),
            }),
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/does not match authorized signer/);
});

test('open flow calls transactionHandler.handleOpen with correct args', async () => {
    const channelId = `channel-handler-open-${crypto.randomUUID()}`;
    let handledChannelId: string | null = null;
    let handledTransaction: string | null = null;
    let handledDeposit: string | null = null;

    const method = createMethod({
        transactionHandler: {
            async handleOpen(cid, tx, deposit) {
                handledChannelId = cid;
                handledTransaction = tx;
                handledDeposit = deposit;
                return 'mock-open-signature';
            },
        },
    });

    const receipt = await method.verify({
        credential: await buildOpenCredential({
            channelId,
            depositAmount: '1000',
            cumulativeAmount: '0',
        }),
        request: buildChallengeRequest(),
    });

    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe('mock-open-signature');
    expect(handledChannelId).toBe(channelId);
    expect(handledTransaction).toBe('dHJhbnNhY3Rpb24tYnl0ZXM=');
    expect(handledDeposit).toBe('1000');
});

test('open flow rejects when transactionHandler.handleOpen throws', async () => {
    const channelId = `channel-handler-reject-${crypto.randomUUID()}`;

    const method = createMethod({
        transactionHandler: {
            async handleOpen() {
                throw new Error('open transaction rejected by handler');
            },
        },
    });

    await expect(
        method.verify({
            credential: await buildOpenCredential({
                channelId,
                depositAmount: '1000',
                cumulativeAmount: '0',
            }),
            request: buildChallengeRequest(),
        }),
    ).rejects.toThrow(/open transaction rejected by handler/);
});

// ---------- helpers ----------

function createMethod(overrides: Partial<session.Parameters> = {}) {
    return session({
        recipient: RECIPIENT,
        currency: TOKEN_MINT,
        amount: '10',
        channelProgram: CHANNEL_PROGRAM,
        store,
        ...overrides,
    });
}

function buildChallengeRequest(overrides: Partial<ChallengeRequest> = {}): ChallengeRequest {
    return {
        amount: '10',
        currency: TOKEN_MINT,
        recipient: RECIPIENT,
        methodDetails: { channelProgram: CHANNEL_PROGRAM, network: 'devnet' },
        ...overrides,
    };
}

async function buildSignedVoucher(input: {
    channelId: string;
    cumulativeAmount: string;
    signer?: Awaited<ReturnType<typeof generateKeyPairSigner>>;
    signatureType?: SignedSessionVoucher['signatureType'];
}): Promise<SignedSessionVoucher> {
    const signer = input.signer ?? payerSigner;

    const voucher = await signVoucher(signer, {
        channelId: input.channelId,
        cumulativeAmount: input.cumulativeAmount,
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
    const voucher =
        options.voucher ??
        (await buildSignedVoucher({
            channelId: options.channelId,
            cumulativeAmount: options.cumulativeAmount ?? '0',
        }));

    return {
        payload: {
            action: 'open',
            channelId: options.channelId,
            payer: payerSigner.address,
            depositAmount: options.depositAmount ?? '1000',
            transaction: 'dHJhbnNhY3Rpb24tYnl0ZXM=',
            voucher,
        },
        challenge: {
            id: options.challengeId ?? 'challenge-open',
            request: buildChallengeRequest(),
        },
    };
}

async function buildVoucherCredential(options: VoucherCredentialOptions): Promise<any> {
    const voucher =
        options.voucher ??
        (await buildSignedVoucher({
            channelId: options.channelId,
            cumulativeAmount: options.cumulativeAmount,
        }));

    return {
        payload: {
            action: 'voucher',
            channelId: options.channelId,
            voucher,
        },
        challenge: {
            id: options.challengeId ?? 'challenge-voucher',
            request: buildChallengeRequest(),
        },
    };
}

async function buildCloseCredential(options: CloseCredentialOptions): Promise<any> {
    const voucher = options.cumulativeAmount
        ? (options.voucher ??
          (await buildSignedVoucher({
              channelId: options.channelId,
              cumulativeAmount: options.cumulativeAmount,
          })))
        : options.voucher;

    return {
        payload: {
            action: 'close',
            channelId: options.channelId,
            ...(voucher ? { voucher } : {}),
        },
        challenge: {
            id: options.challengeId ?? 'challenge-close',
            request: buildChallengeRequest(),
        },
    };
}

function buildTopUpCredential(options: TopUpCredentialOptions): any {
    return {
        payload: {
            action: 'topUp',
            channelId: options.channelId,
            additionalAmount: options.additionalAmount,
            transaction: options.transaction,
        },
        challenge: {
            id: options.challengeId ?? 'challenge-topup',
            request: buildChallengeRequest(),
        },
    };
}

async function getChannel(channelId: string): Promise<ChannelState | null> {
    const channelStore = ChannelStore.fromStore(store);
    return await channelStore.getChannel(channelId);
}
