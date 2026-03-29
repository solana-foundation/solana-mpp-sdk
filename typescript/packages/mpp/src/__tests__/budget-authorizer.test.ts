/**
 * Tests for session/authorizers/BudgetAuthorizer.ts.
 *
 * Covers: construction validation, capabilities, open/update/topup/close flows,
 * budget limit enforcement, monotonic enforcement, program allowlist, expiration,
 * and Swig module integration (using mock SwigModule).
 */
import { generateKeyPairSigner, type MessagePartialSigner } from '@solana/kit';

import {
    BudgetAuthorizer,
    type BudgetAuthorizerParameters,
    type BudgetSwigModule,
} from '../session/authorizers/BudgetAuthorizer.js';
import type { AuthorizeOpenInput } from '../session/Types.js';

const CHANNEL_PROGRAM = 'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB';
const RECIPIENT = '9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ';
const SWIG_ADDRESS = 'Swig11111111111111111111111111111111111111';
const NETWORK = 'devnet';

let signer: MessagePartialSigner;

beforeEach(async () => {
    signer = await generateKeyPairSigner();
});

function mockSwigModule(overrides: {
    canUseProgram?: (pid: string) => boolean;
    solSpendLimit?: () => bigint | null;
    tokenSpendLimit?: (mint: string) => bigint | null;
} = {}): BudgetSwigModule {
    return {
        fetchSwig: async () => ({
            findRoleById: (id: number) => ({
                id,
                actions: {
                    canUseProgram: overrides.canUseProgram ?? (() => true),
                    solSpendLimit: overrides.solSpendLimit ?? (() => 10000n),
                    tokenSpendLimit: overrides.tokenSpendLimit ?? (() => 10000n),
                },
            }),
            findRolesByEd25519SignerPk: (signerPk: string) => {
                if (signerPk === signer.address) {
                    return [{ id: 1, actions: {} }];
                }
                return [];
            },
        }),
    };
}

function makeParams(overrides: Partial<BudgetAuthorizerParameters> = {}): BudgetAuthorizerParameters {
    return {
        maxCumulativeAmount: '5000',
        signer,
        swig: {
            swigAddress: SWIG_ADDRESS,
            swigRoleId: 1,
        },
        swigModule: mockSwigModule(),
        buildOpenTx: async () => 'mock-open-tx',
        buildTopupTx: async () => 'mock-topup-tx',
        ...overrides,
    };
}

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

describe('BudgetAuthorizer construction', () => {
    test('throws when swig config is missing', () => {
        expect(
            () =>
                new BudgetAuthorizer({
                    maxCumulativeAmount: '5000',
                    signer,
                    swig: undefined as any,
                }),
        ).toThrow(/swig/i);
    });

    test('throws when swigRoleId is negative', () => {
        expect(
            () =>
                new BudgetAuthorizer({
                    maxCumulativeAmount: '5000',
                    signer,
                    swig: { swigAddress: SWIG_ADDRESS, swigRoleId: -1 },
                }),
        ).toThrow(/non-negative integer/);
    });

    test('throws when swigRoleId is not an integer', () => {
        expect(
            () =>
                new BudgetAuthorizer({
                    maxCumulativeAmount: '5000',
                    signer,
                    swig: { swigAddress: SWIG_ADDRESS, swigRoleId: 1.5 },
                }),
        ).toThrow(/non-negative integer/);
    });

    test('throws when swigAddress is empty', () => {
        expect(
            () =>
                new BudgetAuthorizer({
                    maxCumulativeAmount: '5000',
                    signer,
                    swig: { swigAddress: '  ', swigRoleId: 1 },
                }),
        ).toThrow(/non-empty string/);
    });

    test('throws on invalid maxCumulativeAmount', () => {
        expect(
            () =>
                new BudgetAuthorizer({
                    maxCumulativeAmount: 'bad',
                    signer,
                    swig: { swigAddress: SWIG_ADDRESS, swigRoleId: 1 },
                }),
        ).toThrow(/valid integer string/);
    });

    test('throws on invalid validUntil timestamp', () => {
        expect(
            () =>
                new BudgetAuthorizer(
                    makeParams({ validUntil: 'not-a-date' }),
                ),
        ).toThrow(/valid ISO timestamp/);
    });

    test('getMode returns regular_budget', () => {
        const auth = new BudgetAuthorizer(makeParams());
        expect(auth.getMode()).toBe('regular_budget');
    });

    test('getCapabilities returns expected shape', () => {
        const auth = new BudgetAuthorizer(
            makeParams({
                maxDepositAmount: '2000',
                allowedPrograms: [CHANNEL_PROGRAM],
                validUntil: '2030-01-01T00:00:00.000Z',
            }),
        );

        const caps = auth.getCapabilities();
        expect(caps.mode).toBe('regular_budget');
        expect(caps.maxCumulativeAmount).toBe('5000');
        expect(caps.maxDepositAmount).toBe('2000');
        expect(caps.expiresAt).toBe('2030-01-01T00:00:00.000Z');
        expect(caps.allowedPrograms).toEqual([CHANNEL_PROGRAM]);
        expect(caps.allowedActions).toEqual(['open', 'update', 'topup', 'close']);
    });
});

describe('authorizeOpen', () => {
    test('returns openTx and signed voucher', async () => {
        const auth = new BudgetAuthorizer(makeParams());
        const input = makeOpenInput();

        const result = await auth.authorizeOpen(input);

        expect(result.openTx).toBe('mock-open-tx');
        expect(result.voucher.voucher.channelId).toBe(input.channelId);
        expect(result.voucher.voucher.cumulativeAmount).toBe('0');
        expect(result.voucher.voucher.sequence).toBe(0);
        expect(result.voucher.voucher.payer).toBe(signer.address);
        expect(result.capabilities.mode).toBe('regular_budget');
    });

    test('throws when deposit exceeds maxDepositAmount', async () => {
        const auth = new BudgetAuthorizer(
            makeParams({
                maxDepositAmount: '500',
                swigModule: mockSwigModule({ solSpendLimit: () => 500n }),
            }),
        );

        await expect(
            auth.authorizeOpen(makeOpenInput({ depositAmount: '600' })),
        ).rejects.toThrow(/maxDepositAmount/);
    });

    test('throws when buildOpenTx is not provided', async () => {
        const auth = new BudgetAuthorizer(
            makeParams({ buildOpenTx: undefined }),
        );

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/buildOpenTx/);
    });

    test('clamps maxCumulativeAmount to on-chain spend limit', async () => {
        const auth = new BudgetAuthorizer(
            makeParams({
                maxCumulativeAmount: '10000',
                swigModule: mockSwigModule({ solSpendLimit: () => 3000n }),
            }),
        );

        const channelId = `ch-clamp-${crypto.randomUUID()}`;
        await auth.authorizeOpen(makeOpenInput({ channelId }));

        // Should be clamped to 3000 from the on-chain limit
        await expect(
            auth.authorizeUpdate({
                channelId,
                channelProgram: CHANNEL_PROGRAM,
                cumulativeAmount: '3001',
                meter: 'api',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 1,
                serverNonce: crypto.randomUUID(),
                units: '1',
            }),
        ).rejects.toThrow(/maxCumulativeAmount/);
    });

    test('rejects when Swig role disallows program', async () => {
        const auth = new BudgetAuthorizer(
            makeParams({
                swigModule: mockSwigModule({ canUseProgram: () => false }),
            }),
        );

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/does not allow/);
    });
});

describe('authorizeUpdate', () => {
    test('signs update voucher after open', async () => {
        const channelId = `ch-up-${crypto.randomUUID()}`;
        const auth = new BudgetAuthorizer(makeParams());

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        const result = await auth.authorizeUpdate({
            channelId,
            channelProgram: CHANNEL_PROGRAM,
            cumulativeAmount: '300',
            meter: 'api',
            network: NETWORK,
            recipient: RECIPIENT,
            sequence: 1,
            serverNonce: crypto.randomUUID(),
            units: '1',
        });

        expect(result.voucher.voucher.cumulativeAmount).toBe('300');
    });

    test('throws when channel has not been opened', async () => {
        const auth = new BudgetAuthorizer(makeParams());

        await expect(
            auth.authorizeUpdate({
                channelId: 'unknown-channel',
                channelProgram: CHANNEL_PROGRAM,
                cumulativeAmount: '100',
                meter: 'api',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 1,
                serverNonce: crypto.randomUUID(),
                units: '1',
            }),
        ).rejects.toThrow(/Unknown channel/);
    });

    test('rejects cumulative amount exceeding maxCumulativeAmount', async () => {
        const channelId = `ch-max-${crypto.randomUUID()}`;

        // Mock swig to return a limit >= 100, and use a deposit that fits within it
        const authWithMock = new BudgetAuthorizer(
            makeParams({
                maxCumulativeAmount: '100',
                swigModule: mockSwigModule({ solSpendLimit: () => 1000n }),
            }),
        );

        await authWithMock.authorizeOpen(makeOpenInput({ channelId, depositAmount: '100' }));

        await expect(
            authWithMock.authorizeUpdate({
                channelId,
                channelProgram: CHANNEL_PROGRAM,
                cumulativeAmount: '101',
                meter: 'api',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 1,
                serverNonce: crypto.randomUUID(),
                units: '1',
            }),
        ).rejects.toThrow(/maxCumulativeAmount/);
    });

    test('enforces monotonic sequence', async () => {
        const channelId = `ch-mono-${crypto.randomUUID()}`;
        const auth = new BudgetAuthorizer(makeParams());

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        await auth.authorizeUpdate({
            channelId,
            channelProgram: CHANNEL_PROGRAM,
            cumulativeAmount: '100',
            meter: 'api',
            network: NETWORK,
            recipient: RECIPIENT,
            sequence: 1,
            serverNonce: crypto.randomUUID(),
            units: '1',
        });

        await expect(
            auth.authorizeUpdate({
                channelId,
                channelProgram: CHANNEL_PROGRAM,
                cumulativeAmount: '200',
                meter: 'api',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 1, // Replay
                serverNonce: crypto.randomUUID(),
                units: '1',
            }),
        ).rejects.toThrow(/Sequence must increase/);
    });
});

describe('authorizeTopup', () => {
    test('returns topupTx after open', async () => {
        const channelId = `ch-topup-${crypto.randomUUID()}`;
        const auth = new BudgetAuthorizer(makeParams());

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        const result = await auth.authorizeTopup({
            additionalAmount: '500',
            channelId,
            channelProgram: CHANNEL_PROGRAM,
            network: NETWORK,
        });

        expect(result.topupTx).toBe('mock-topup-tx');
    });

    test('throws when channel is unknown', async () => {
        const auth = new BudgetAuthorizer(makeParams());

        await expect(
            auth.authorizeTopup({
                additionalAmount: '500',
                channelId: 'unknown',
                channelProgram: CHANNEL_PROGRAM,
                network: NETWORK,
            }),
        ).rejects.toThrow(/Unknown channel/);
    });

    test('throws when topup exceeds maxDepositAmount', async () => {
        const channelId = `ch-topup-limit-${crypto.randomUUID()}`;
        const auth = new BudgetAuthorizer(
            makeParams({
                maxDepositAmount: '1500',
                swigModule: mockSwigModule({ solSpendLimit: () => 1500n }),
            }),
        );

        await auth.authorizeOpen(makeOpenInput({ channelId, depositAmount: '1000' }));

        await expect(
            auth.authorizeTopup({
                additionalAmount: '600', // 1000 + 600 = 1600 > 1500
                channelId,
                channelProgram: CHANNEL_PROGRAM,
                network: NETWORK,
            }),
        ).rejects.toThrow(/maxDepositAmount/);
    });

    test('throws when buildTopupTx is not provided', async () => {
        const channelId = `ch-no-topup-${crypto.randomUUID()}`;
        const auth = new BudgetAuthorizer(
            makeParams({ buildTopupTx: undefined }),
        );

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        await expect(
            auth.authorizeTopup({
                additionalAmount: '100',
                channelId,
                channelProgram: CHANNEL_PROGRAM,
                network: NETWORK,
            }),
        ).rejects.toThrow(/buildTopupTx/);
    });
});

describe('authorizeClose', () => {
    test('returns signed close voucher', async () => {
        const channelId = `ch-close-${crypto.randomUUID()}`;
        const auth = new BudgetAuthorizer(makeParams());

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

        expect(result.voucher.voucher.meter).toBe('close');
        expect(result.voucher.voucher.cumulativeAmount).toBe('0');
    });

    test('throws when final cumulative amount exceeds limit', async () => {
        const channelId = `ch-close-over-${crypto.randomUUID()}`;
        const auth = new BudgetAuthorizer(
            makeParams({
                maxCumulativeAmount: '500',
                swigModule: mockSwigModule({ solSpendLimit: () => 1000n }),
            }),
        );

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        await expect(
            auth.authorizeClose({
                channelId,
                channelProgram: CHANNEL_PROGRAM,
                finalCumulativeAmount: '501',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 1,
                serverNonce: crypto.randomUUID(),
            }),
        ).rejects.toThrow(/maxCumulativeAmount/);
    });

    test('throws when channel is unknown', async () => {
        const auth = new BudgetAuthorizer(makeParams());

        await expect(
            auth.authorizeClose({
                channelId: 'unknown',
                channelProgram: CHANNEL_PROGRAM,
                finalCumulativeAmount: '0',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 1,
                serverNonce: crypto.randomUUID(),
            }),
        ).rejects.toThrow(/Unknown channel/);
    });
});

describe('expiration', () => {
    test('rejects operations after policy expiry', async () => {
        const auth = new BudgetAuthorizer(
            makeParams({ validUntil: '2000-01-01T00:00:00.000Z' }),
        );

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/expired/);
    });
});

describe('program allowlist', () => {
    test('rejects disallowed program', async () => {
        const auth = new BudgetAuthorizer(
            makeParams({ allowedPrograms: ['otherProgram'] }),
        );

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/not allowed/);
    });
});

describe('SPL budget validation', () => {
    test('uses tokenSpendLimit for SPL assets', async () => {
        const auth = new BudgetAuthorizer(
            makeParams({
                maxCumulativeAmount: '10000',
                swigModule: mockSwigModule({
                    tokenSpendLimit: (mint: string) => (mint === 'USDC_MINT' ? 2000n : null),
                }),
            }),
        );

        const channelId = `ch-spl-${crypto.randomUUID()}`;
        await auth.authorizeOpen(
            makeOpenInput({
                channelId,
                asset: { decimals: 6, kind: 'spl', mint: 'USDC_MINT' },
            }),
        );

        await expect(
            auth.authorizeUpdate({
                channelId,
                channelProgram: CHANNEL_PROGRAM,
                cumulativeAmount: '2001',
                meter: 'api',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 1,
                serverNonce: crypto.randomUUID(),
                units: '1',
            }),
        ).rejects.toThrow(/maxCumulativeAmount/);
    });

    test('throws when SPL asset missing mint', async () => {
        const auth = new BudgetAuthorizer(makeParams());

        await expect(
            auth.authorizeOpen(
                makeOpenInput({
                    asset: { decimals: 6, kind: 'spl' },
                }),
            ),
        ).rejects.toThrow(/mint is required/);
    });
});
