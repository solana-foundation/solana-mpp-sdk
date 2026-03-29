/**
 * Tests for session/authorizers/SwigSessionAuthorizer.ts.
 *
 * Covers: construction, capabilities, open/update/topup/close flows,
 * session key management, spend/deposit limits, program allowlist,
 * expiration, monotonic enforcement, and Swig module integration.
 */
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';

import {
    SwigSessionAuthorizer,
    type SwigSessionAuthorizerParameters,
    type SwigSessionModule,
    type SwigWalletAdapter,
} from '../session/authorizers/SwigSessionAuthorizer.js';
import type { AuthorizeOpenInput } from '../session/Types.js';

const CHANNEL_PROGRAM = 'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB';
const RECIPIENT = '9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ';
const SWIG_ADDRESS = 'Swig11111111111111111111111111111111111111';
const NETWORK = 'devnet';
const ROLE_ID = 42;

let sessionKeySigner: KeyPairSigner;

beforeEach(async () => {
    sessionKeySigner = await generateKeyPairSigner();
});

function mockSwigModule(overrides: {
    canUseProgram?: (pid: string) => boolean;
    solSpendLimit?: () => bigint | null;
    tokenSpendLimit?: (mint: string) => bigint | null;
} = {}): SwigSessionModule {
    return {
        fetchSwig: async () => ({
            findRoleById: (id: number) => ({
                id,
                actions: {
                    canUseProgram: overrides.canUseProgram ?? (() => true),
                    solSpendLimit: overrides.solSpendLimit ?? (() => 100000n),
                    tokenSpendLimit: overrides.tokenSpendLimit ?? (() => 100000n),
                },
            }),
            findRoleBySessionKey: (key: string) => {
                if (key === sessionKeySigner.address) {
                    return {
                        id: ROLE_ID,
                        actions: {
                            canUseProgram: overrides.canUseProgram ?? (() => true),
                            solSpendLimit: overrides.solSpendLimit ?? (() => 100000n),
                            tokenSpendLimit: overrides.tokenSpendLimit ?? (() => 100000n),
                        },
                    };
                }
                return null;
            },
        }),
    };
}

function makeWallet(overrides: Partial<SwigWalletAdapter> = {}): SwigWalletAdapter {
    return {
        address: 'wallet-address',
        swigAddress: SWIG_ADDRESS,
        swigRoleId: ROLE_ID,
        createSessionKey: async () => ({
            signer: sessionKeySigner,
            openTx: 'session-open-tx',
            swigRoleId: ROLE_ID,
            createdAt: Date.now(),
        }),
        ...overrides,
    };
}

function makeParams(overrides: Partial<SwigSessionAuthorizerParameters> = {}): SwigSessionAuthorizerParameters {
    return {
        policy: {
            profile: 'swig-time-bound',
            ttlSeconds: 3600,
        },
        wallet: makeWallet(),
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

describe('SwigSessionAuthorizer construction', () => {
    test('throws when ttlSeconds is not a positive integer', () => {
        expect(
            () =>
                new SwigSessionAuthorizer(
                    makeParams({
                        policy: { profile: 'swig-time-bound', ttlSeconds: 0 },
                    }),
                ),
        ).toThrow(/positive integer/);
    });

    test('throws when ttlSeconds is negative', () => {
        expect(
            () =>
                new SwigSessionAuthorizer(
                    makeParams({
                        policy: { profile: 'swig-time-bound', ttlSeconds: -1 },
                    }),
                ),
        ).toThrow(/positive integer/);
    });

    test('throws when ttlSeconds is not an integer', () => {
        expect(
            () =>
                new SwigSessionAuthorizer(
                    makeParams({
                        policy: { profile: 'swig-time-bound', ttlSeconds: 1.5 },
                    }),
                ),
        ).toThrow(/positive integer/);
    });

    test('getMode returns swig_session', () => {
        const auth = new SwigSessionAuthorizer(makeParams());
        expect(auth.getMode()).toBe('swig_session');
    });

    test('getCapabilities returns expected shape', () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                    spendLimit: '5000',
                    depositLimit: '2000',
                },
                allowedPrograms: [CHANNEL_PROGRAM],
            }),
        );

        const caps = auth.getCapabilities();
        expect(caps.mode).toBe('swig_session');
        expect(caps.maxCumulativeAmount).toBe('5000');
        expect(caps.maxDepositAmount).toBe('2000');
        expect(caps.allowedPrograms).toEqual([CHANNEL_PROGRAM]);
        expect(caps.allowedActions).toEqual(['open', 'update', 'topup', 'close']);
        expect(caps.requiresInteractiveApproval.open).toBe(true);
        expect(caps.requiresInteractiveApproval.update).toBe(false);
        expect(caps.expiresAt).toBeDefined();
    });

    test('autoTopup affects topup interactive approval', () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                    autoTopup: { amount: '1000', enabled: true, triggerBelow: '100' },
                },
            }),
        );

        const caps = auth.getCapabilities();
        expect(caps.requiresInteractiveApproval.topup).toBe(false);
    });

    test('topup requires approval when autoTopup is not enabled', () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                },
            }),
        );

        const caps = auth.getCapabilities();
        expect(caps.requiresInteractiveApproval.topup).toBe(true);
    });
});

describe('authorizeOpen', () => {
    test('returns signed voucher with swig-session signatureType', async () => {
        const auth = new SwigSessionAuthorizer(makeParams());
        const input = makeOpenInput();
        const result = await auth.authorizeOpen(input);

        expect(result.voucher.signatureType).toBe('swig-session');
        expect(result.voucher.voucher.channelId).toBe(input.channelId);
        expect(result.voucher.voucher.cumulativeAmount).toBe('0');
        expect(result.voucher.voucher.sequence).toBe(0);
        expect(result.voucher.voucher.payer).toBe('wallet-address');
        expect(result.voucher.voucher.chainId).toBe('solana:devnet');
        expect(result.expiresAt).toBeDefined();
    });

    test('uses buildOpenTx when provided', async () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                buildOpenTx: async () => 'custom-open-tx',
            }),
        );

        const result = await auth.authorizeOpen(makeOpenInput());
        expect(result.openTx).toBe('custom-open-tx');
    });

    test('uses session openTx when buildOpenTx is not provided', async () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                buildOpenTx: undefined,
                wallet: makeWallet({
                    createSessionKey: async () => ({
                        signer: sessionKeySigner,
                        openTx: 'session-created-open-tx',
                        createdAt: Date.now(),
                    }),
                }),
            }),
        );

        const result = await auth.authorizeOpen(makeOpenInput());
        expect(result.openTx).toBe('session-created-open-tx');
    });

    test('throws when neither buildOpenTx nor session openTx available', async () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                buildOpenTx: undefined,
                wallet: makeWallet({
                    createSessionKey: async () => ({
                        signer: sessionKeySigner,
                        // No openTx provided
                        createdAt: Date.now(),
                    }),
                }),
            }),
        );

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/buildOpenTx|openTx/);
    });

    test('throws when deposit exceeds depositLimit', async () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                    depositLimit: '500',
                },
            }),
        );

        await expect(
            auth.authorizeOpen(makeOpenInput({ depositAmount: '600' })),
        ).rejects.toThrow(/depositLimit/);
    });

    test('creates a session key via createSessionKey', async () => {
        let createCalled = false;
        const auth = new SwigSessionAuthorizer(
            makeParams({
                wallet: makeWallet({
                    createSessionKey: async () => {
                        createCalled = true;
                        return {
                            signer: sessionKeySigner,
                            openTx: 'tx',
                            createdAt: Date.now(),
                        };
                    },
                }),
            }),
        );

        await auth.authorizeOpen(makeOpenInput());
        expect(createCalled).toBe(true);
    });

    test('reuses existing session key for subsequent opens', async () => {
        let createCount = 0;
        const auth = new SwigSessionAuthorizer(
            makeParams({
                wallet: makeWallet({
                    createSessionKey: async () => {
                        createCount++;
                        return {
                            signer: sessionKeySigner,
                            openTx: 'tx',
                            createdAt: Date.now(),
                        };
                    },
                }),
            }),
        );

        await auth.authorizeOpen(makeOpenInput());
        await auth.authorizeOpen(makeOpenInput());
        // Should only create once (second open reuses the non-expired session)
        expect(createCount).toBe(1);
    });

    test('tries getSessionKey before createSessionKey', async () => {
        let getCalled = false;
        const auth = new SwigSessionAuthorizer(
            makeParams({
                wallet: makeWallet({
                    getSessionKey: async () => {
                        getCalled = true;
                        return {
                            signer: sessionKeySigner,
                            openTx: 'existing-tx',
                            createdAt: Date.now(),
                        };
                    },
                    createSessionKey: async () => {
                        throw new Error('should not be called');
                    },
                }),
            }),
        );

        await auth.authorizeOpen(makeOpenInput());
        expect(getCalled).toBe(true);
    });
});

describe('authorizeUpdate', () => {
    test('signs update voucher after open', async () => {
        const channelId = `ch-up-${crypto.randomUUID()}`;
        const serverNonce = crypto.randomUUID();
        const auth = new SwigSessionAuthorizer(makeParams());

        await auth.authorizeOpen(makeOpenInput({ channelId, serverNonce }));

        const result = await auth.authorizeUpdate({
            channelId,
            channelProgram: CHANNEL_PROGRAM,
            cumulativeAmount: '300',
            meter: 'api',
            network: NETWORK,
            recipient: RECIPIENT,
            sequence: 1,
            serverNonce,
            units: '1',
        });

        expect(result.voucher.signatureType).toBe('swig-session');
        expect(result.voucher.voucher.cumulativeAmount).toBe('300');
        expect(result.voucher.voucher.sequence).toBe(1);
    });

    test('throws when no session key is active', async () => {
        const auth = new SwigSessionAuthorizer(makeParams());

        await expect(
            auth.authorizeUpdate({
                channelId: 'unknown',
                channelProgram: CHANNEL_PROGRAM,
                cumulativeAmount: '100',
                meter: 'api',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 1,
                serverNonce: crypto.randomUUID(),
                units: '1',
            }),
        ).rejects.toThrow(/No active Swig session key/);
    });

    test('throws when cumulative amount exceeds spendLimit', async () => {
        const channelId = `ch-spend-${crypto.randomUUID()}`;
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                    spendLimit: '200',
                },
                swigModule: mockSwigModule({ solSpendLimit: () => 200n }),
            }),
        );

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        await expect(
            auth.authorizeUpdate({
                channelId,
                channelProgram: CHANNEL_PROGRAM,
                cumulativeAmount: '201',
                meter: 'api',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 1,
                serverNonce: crypto.randomUUID(),
                units: '1',
            }),
        ).rejects.toThrow(/spendLimit/);
    });

    test('enforces monotonic sequence', async () => {
        const channelId = `ch-mono-${crypto.randomUUID()}`;
        const auth = new SwigSessionAuthorizer(makeParams());

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
                sequence: 1, // Same sequence
                serverNonce: crypto.randomUUID(),
                units: '1',
            }),
        ).rejects.toThrow(/Sequence must increase/);
    });

    test('enforces monotonic cumulative amount', async () => {
        const channelId = `ch-mono-amt-${crypto.randomUUID()}`;
        const auth = new SwigSessionAuthorizer(makeParams());

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        await auth.authorizeUpdate({
            channelId,
            channelProgram: CHANNEL_PROGRAM,
            cumulativeAmount: '500',
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
                cumulativeAmount: '400',
                meter: 'api',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 2,
                serverNonce: crypto.randomUUID(),
                units: '1',
            }),
        ).rejects.toThrow(/must not decrease/);
    });
});

describe('authorizeTopup', () => {
    test('returns topupTx after open', async () => {
        const channelId = `ch-topup-${crypto.randomUUID()}`;
        const auth = new SwigSessionAuthorizer(makeParams());

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        const result = await auth.authorizeTopup({
            additionalAmount: '500',
            channelId,
            channelProgram: CHANNEL_PROGRAM,
            network: NETWORK,
        });

        expect(result.topupTx).toBe('mock-topup-tx');
    });

    test('throws when topup exceeds depositLimit', async () => {
        const channelId = `ch-topup-limit-${crypto.randomUUID()}`;
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                    depositLimit: '1200',
                },
                swigModule: mockSwigModule({ solSpendLimit: () => 1200n }),
            }),
        );

        await auth.authorizeOpen(makeOpenInput({ channelId, depositAmount: '1000' }));

        await expect(
            auth.authorizeTopup({
                additionalAmount: '300', // 1000 + 300 = 1300 > 1200
                channelId,
                channelProgram: CHANNEL_PROGRAM,
                network: NETWORK,
            }),
        ).rejects.toThrow(/depositLimit/);
    });

    test('throws when buildTopupTx is not provided', async () => {
        const channelId = `ch-no-topup-${crypto.randomUUID()}`;
        const auth = new SwigSessionAuthorizer(
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
        const auth = new SwigSessionAuthorizer(makeParams());

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

        expect(result.voucher.signatureType).toBe('swig-session');
        expect(result.voucher.voucher.meter).toBe('close');
    });

    test('throws when final cumulative amount exceeds spendLimit', async () => {
        const channelId = `ch-close-limit-${crypto.randomUUID()}`;
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                    spendLimit: '500',
                },
                swigModule: mockSwigModule({ solSpendLimit: () => 500n }),
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
        ).rejects.toThrow(/spendLimit/);
    });

    test('returns closeTx when buildCloseTx is provided', async () => {
        const channelId = `ch-close-tx-${crypto.randomUUID()}`;
        const auth = new SwigSessionAuthorizer(
            makeParams({
                buildCloseTx: async () => 'close-tx',
            }),
        );

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
});

describe('program allowlist', () => {
    test('rejects disallowed program', async () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                allowedPrograms: ['otherProgram111111111111111111111'],
            }),
        );

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/not allowed/);
    });
});

describe('on-chain policy validation', () => {
    test('rejects when Swig role disallows channel program', async () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                swigModule: mockSwigModule({ canUseProgram: () => false }),
            }),
        );

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/does not allow/);
    });

    test('rejects when swigAddress is missing for on-chain validation', async () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                wallet: makeWallet({ swigAddress: undefined }),
            }),
        );

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/swigAddress/);
    });

    test('validates SPL token spend limit for SPL assets', async () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                    spendLimit: '5000',
                },
                swigModule: mockSwigModule({
                    tokenSpendLimit: (mint: string) => (mint === 'USDC_MINT' ? 3000n : null),
                }),
            }),
        );

        // Should not throw -- the on-chain limit (3000) is <= policy spendLimit (5000)
        await expect(
            auth.authorizeOpen(
                makeOpenInput({
                    asset: { decimals: 6, kind: 'spl', mint: 'USDC_MINT' },
                }),
            ),
        ).resolves.toBeTruthy();
    });

    test('rejects SPL asset without mint', async () => {
        const auth = new SwigSessionAuthorizer(makeParams());

        await expect(
            auth.authorizeOpen(
                makeOpenInput({
                    asset: { decimals: 6, kind: 'spl' },
                }),
            ),
        ).rejects.toThrow(/mint is required/);
    });

    test('rejects uncapped on-chain limit when policy has a spendLimit', async () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                    spendLimit: '5000',
                },
                swigModule: mockSwigModule({
                    solSpendLimit: () => null, // Uncapped
                }),
            }),
        );

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/uncapped/);
    });

    test('rejects on-chain limit exceeding policy spendLimit', async () => {
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                    spendLimit: '1000',
                },
                swigModule: mockSwigModule({
                    solSpendLimit: () => 5000n, // Higher than policy
                }),
            }),
        );

        await expect(auth.authorizeOpen(makeOpenInput())).rejects.toThrow(/exceeds policy/);
    });
});

describe('session expiration', () => {
    test('expired session key blocks update', async () => {
        const channelId = `ch-expired-${crypto.randomUUID()}`;
        const auth = new SwigSessionAuthorizer(
            makeParams({
                policy: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 1, // 1 second TTL
                },
                wallet: makeWallet({
                    createSessionKey: async () => ({
                        signer: sessionKeySigner,
                        openTx: 'tx',
                        createdAt: Date.now() - 5000, // Created 5 seconds ago, already expired
                    }),
                }),
            }),
        );

        await auth.authorizeOpen(makeOpenInput({ channelId }));

        await expect(
            auth.authorizeUpdate({
                channelId,
                channelProgram: CHANNEL_PROGRAM,
                cumulativeAmount: '100',
                meter: 'api',
                network: NETWORK,
                recipient: RECIPIENT,
                sequence: 1,
                serverNonce: crypto.randomUUID(),
                units: '1',
            }),
        ).rejects.toThrow(/expired/);
    });
});

describe('invalid spendLimit / depositLimit', () => {
    test('throws when spendLimit is not a valid integer', () => {
        expect(
            () =>
                new SwigSessionAuthorizer(
                    makeParams({
                        policy: {
                            profile: 'swig-time-bound',
                            ttlSeconds: 3600,
                            spendLimit: 'not-a-number',
                        },
                    }),
                ),
        ).toThrow(/valid integer string/);
    });

    test('throws when depositLimit is negative', () => {
        expect(
            () =>
                new SwigSessionAuthorizer(
                    makeParams({
                        policy: {
                            profile: 'swig-time-bound',
                            ttlSeconds: 3600,
                            depositLimit: '-1',
                        },
                    }),
                ),
        ).toThrow(/non-negative/);
    });
});
