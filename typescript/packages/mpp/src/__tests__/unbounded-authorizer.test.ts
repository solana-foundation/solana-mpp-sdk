/**
 * Tests for session/authorizers/UnboundedAuthorizer.ts.
 *
 * Covers: construction, capabilities, open/update/topup/close flows,
 * monotonic enforcement, program allowlist, expiration, and tx builder callbacks.
 */
import { generateKeyPairSigner, type MessagePartialSigner } from '@solana/kit';

import { UnboundedAuthorizer } from '../session/authorizers/UnboundedAuthorizer.js';
import type { AuthorizeCloseInput, AuthorizeOpenInput, AuthorizeUpdateInput } from '../session/Types.js';

const CHANNEL_PROGRAM = 'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB';
const RECIPIENT = '9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ';
const NETWORK = 'devnet';

let signer: MessagePartialSigner;

beforeEach(async () => {
    signer = await generateKeyPairSigner();
});

function makeOpenInput(overrides: Partial<AuthorizeOpenInput> = {}): AuthorizeOpenInput {
    return {
        asset: { decimals: 9, kind: 'sol' },
        channelId: `channel-${crypto.randomUUID()}`,
        channelProgram: CHANNEL_PROGRAM,
        depositAmount: '1000',
        network: NETWORK,
        recipient: RECIPIENT,
        serverNonce: crypto.randomUUID(),
        ...overrides,
    };
}

function makeUpdateInput(overrides: Partial<AuthorizeUpdateInput> = {}): AuthorizeUpdateInput {
    return {
        channelId: 'channel-1',
        channelProgram: CHANNEL_PROGRAM,
        cumulativeAmount: '100',
        meter: 'api_calls',
        network: NETWORK,
        recipient: RECIPIENT,
        sequence: 1,
        serverNonce: crypto.randomUUID(),
        units: '1',
        ...overrides,
    };
}

describe('UnboundedAuthorizer construction', () => {
    test('getMode returns regular_unbounded', () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'open-tx',
        });
        expect(auth.getMode()).toBe('regular_unbounded');
    });

    test('getCapabilities returns expected shape', () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'open-tx',
            allowedPrograms: [CHANNEL_PROGRAM],
            expiresAt: '2030-01-01T00:00:00.000Z',
        });

        const caps = auth.getCapabilities();
        expect(caps.mode).toBe('regular_unbounded');
        expect(caps.expiresAt).toBe('2030-01-01T00:00:00.000Z');
        expect(caps.allowedPrograms).toEqual([CHANNEL_PROGRAM]);
        expect(caps.allowedActions).toEqual(['open', 'update', 'topup', 'close']);
        expect(caps.requiresInteractiveApproval).toEqual({
            close: false,
            open: false,
            topup: false,
            update: false,
        });
    });

    test('respects requiresInteractiveApproval overrides', () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'open-tx',
            requiresInteractiveApproval: { update: true },
        });

        const caps = auth.getCapabilities();
        expect(caps.requiresInteractiveApproval.update).toBe(true);
        expect(caps.requiresInteractiveApproval.open).toBe(false);
    });
});

describe('authorizeOpen', () => {
    test('returns openTx and signed voucher', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'mock-open-tx',
        });

        const input = makeOpenInput();
        const result = await auth.authorizeOpen(input);

        expect(result.openTx).toBe('mock-open-tx');
        expect(result.voucher.signatureType).toBe('ed25519');
        expect(result.voucher.signer).toBe(signer.address);
        expect(result.voucher.voucher.channelId).toBe(input.channelId);
        expect(result.voucher.voucher.cumulativeAmount).toBe('0');
        expect(result.voucher.voucher.sequence).toBe(0);
        expect(result.voucher.voucher.payer).toBe(signer.address);
        expect(result.voucher.voucher.chainId).toBe('solana:devnet');
    });

    test('includes expiresAt in voucher and result when configured', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
            expiresAt: '2030-12-31T00:00:00.000Z',
        });

        const result = await auth.authorizeOpen(makeOpenInput());
        expect(result.expiresAt).toBe('2030-12-31T00:00:00.000Z');
        expect(result.voucher.voucher.expiresAt).toBe('2030-12-31T00:00:00.000Z');
    });

    test('throws when buildOpenTx is not provided', async () => {
        const auth = new UnboundedAuthorizer({ signer });
        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/buildOpenTx/);
    });

    test('uses pricing meter when provided', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        const input = makeOpenInput({
            pricing: { amountPerUnit: '10', meter: 'custom_meter', unit: 'request' },
        });

        const result = await auth.authorizeOpen(input);
        expect(result.voucher.voucher.meter).toBe('custom_meter');
    });

    test('defaults meter to session when pricing not provided', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        const result = await auth.authorizeOpen(makeOpenInput());
        expect(result.voucher.voucher.meter).toBe('session');
    });
});

describe('authorizeUpdate', () => {
    test('signs update voucher after open', async () => {
        const channelId = `ch-update-${crypto.randomUUID()}`;
        const serverNonce = crypto.randomUUID();
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        await auth.authorizeOpen(makeOpenInput({ channelId, serverNonce }));

        const result = await auth.authorizeUpdate(
            makeUpdateInput({
                channelId,
                cumulativeAmount: '300',
                sequence: 1,
                serverNonce,
            }),
        );

        expect(result.voucher.voucher.cumulativeAmount).toBe('300');
        expect(result.voucher.voucher.sequence).toBe(1);
    });

    test('enforces monotonic sequence', async () => {
        const channelId = `ch-mono-${crypto.randomUUID()}`;
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        await auth.authorizeUpdate(
            makeUpdateInput({ channelId, cumulativeAmount: '100', sequence: 1 }),
        );

        // Replay same sequence
        await expect(
            auth.authorizeUpdate(
                makeUpdateInput({ channelId, cumulativeAmount: '200', sequence: 1 }),
            ),
        ).rejects.toThrow(/Sequence must increase/);
    });

    test('enforces monotonic cumulative amount', async () => {
        const channelId = `ch-mono-amt-${crypto.randomUUID()}`;
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        await auth.authorizeUpdate(
            makeUpdateInput({ channelId, cumulativeAmount: '500', sequence: 1 }),
        );

        await expect(
            auth.authorizeUpdate(
                makeUpdateInput({ channelId, cumulativeAmount: '400', sequence: 2 }),
            ),
        ).rejects.toThrow(/must not decrease/);
    });

    test('rejects negative sequence', async () => {
        const channelId = `ch-neg-seq-${crypto.randomUUID()}`;
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        await expect(
            auth.authorizeUpdate(
                makeUpdateInput({ channelId, sequence: -1 }),
            ),
        ).rejects.toThrow(/non-negative integer/);
    });

    test('rejects invalid cumulativeAmount string', async () => {
        const channelId = `ch-bad-amt-${crypto.randomUUID()}`;
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        await expect(
            auth.authorizeUpdate(
                makeUpdateInput({ channelId, cumulativeAmount: 'not-a-number', sequence: 1 }),
            ),
        ).rejects.toThrow(/valid integer string/);
    });
});

describe('authorizeTopup', () => {
    test('returns topupTx when buildTopupTx is provided', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'open-tx',
            buildTopupTx: async () => 'topup-tx',
        });

        const result = await auth.authorizeTopup({
            additionalAmount: '500',
            channelId: 'ch-topup',
            channelProgram: CHANNEL_PROGRAM,
            network: NETWORK,
        });

        expect(result.topupTx).toBe('topup-tx');
    });

    test('throws when buildTopupTx is not provided', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        await expect(
            auth.authorizeTopup({
                additionalAmount: '500',
                channelId: 'ch',
                channelProgram: CHANNEL_PROGRAM,
                network: NETWORK,
            }),
        ).rejects.toThrow(/buildTopupTx/);
    });

    test('rejects negative additionalAmount', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
            buildTopupTx: async () => 'topup-tx',
        });

        await expect(
            auth.authorizeTopup({
                additionalAmount: '-10',
                channelId: 'ch',
                channelProgram: CHANNEL_PROGRAM,
                network: NETWORK,
            }),
        ).rejects.toThrow(/non-negative/);
    });
});

describe('authorizeClose', () => {
    test('returns signed voucher on close', async () => {
        const channelId = `ch-close-${crypto.randomUUID()}`;
        const serverNonce = crypto.randomUUID();
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        await auth.authorizeOpen(makeOpenInput({ channelId, serverNonce }));
        await auth.authorizeUpdate(
            makeUpdateInput({ channelId, cumulativeAmount: '300', sequence: 1, serverNonce }),
        );

        const result = await auth.authorizeClose({
            channelId,
            channelProgram: CHANNEL_PROGRAM,
            finalCumulativeAmount: '300',
            network: NETWORK,
            recipient: RECIPIENT,
            sequence: 2,
            serverNonce,
        });

        expect(result.voucher.voucher.cumulativeAmount).toBe('300');
        expect(result.voucher.voucher.meter).toBe('close');
        expect(result.voucher.voucher.sequence).toBe(2);
    });

    test('returns closeTx when buildCloseTx is provided', async () => {
        const channelId = `ch-close-tx-${crypto.randomUUID()}`;
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
            buildCloseTx: async () => 'close-tx',
        });

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        const result = await auth.authorizeClose({
            channelId,
            channelProgram: CHANNEL_PROGRAM,
            finalCumulativeAmount: '0',
            network: NETWORK,
            recipient: RECIPIENT,
            sequence: 1,
            serverNonce: crypto.randomUUID(),
        });

        expect(result.closeTx).toBe('close-tx');
    });

    test('closeTx is undefined when buildCloseTx is not provided', async () => {
        const channelId = `ch-no-close-tx-${crypto.randomUUID()}`;
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        const result = await auth.authorizeClose({
            channelId,
            channelProgram: CHANNEL_PROGRAM,
            finalCumulativeAmount: '0',
            network: NETWORK,
            recipient: RECIPIENT,
            sequence: 1,
            serverNonce: crypto.randomUUID(),
        });

        expect(result.closeTx).toBeUndefined();
    });
});

describe('program allowlist', () => {
    test('allows a permitted program', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
            allowedPrograms: [CHANNEL_PROGRAM],
        });

        await expect(auth.authorizeOpen(makeOpenInput())).resolves.toBeTruthy();
    });

    test('rejects a disallowed program', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
            allowedPrograms: ['otherProgram111111111111111111111'],
        });

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/not allowed/);
    });

    test('allows any program when allowedPrograms is omitted', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        await expect(auth.authorizeOpen(makeOpenInput())).resolves.toBeTruthy();
    });
});

describe('expiration', () => {
    test('throws when the authorizer is expired', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
            expiresAt: '2000-01-01T00:00:00.000Z', // Already expired
        });

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/expired/);
    });

    test('does not throw when the authorizer is not expired', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
            expiresAt: '2099-01-01T00:00:00.000Z',
        });

        await expect(auth.authorizeOpen(makeOpenInput())).resolves.toBeTruthy();
    });

    test('throws on invalid expiresAt timestamp', () => {
        expect(
            () =>
                new UnboundedAuthorizer({
                    signer,
                    expiresAt: 'not-a-date',
                }),
        ).toThrow(/valid ISO timestamp/);
    });
});

describe('chainId normalization', () => {
    test('prefixes network with solana: when not already prefixed', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        const result = await auth.authorizeOpen(makeOpenInput({ network: 'mainnet-beta' }));
        expect(result.voucher.voucher.chainId).toBe('solana:mainnet-beta');
    });

    test('does not double-prefix', async () => {
        const auth = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        const result = await auth.authorizeOpen(makeOpenInput({ network: 'solana:devnet' }));
        expect(result.voucher.voucher.chainId).toBe('solana:devnet');
    });
});
