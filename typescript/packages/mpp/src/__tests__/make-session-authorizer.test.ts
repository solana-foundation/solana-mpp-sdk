/**
 * Tests for session/authorizers/makeSessionAuthorizer.ts.
 *
 * Covers: factory dispatch for each profile, required parameter validation,
 * and correct authorizer type instantiation.
 */
import { generateKeyPairSigner, type MessagePartialSigner } from '@solana/kit';

import { makeSessionAuthorizer } from '../session/authorizers/makeSessionAuthorizer.js';
import { BudgetAuthorizer } from '../session/authorizers/BudgetAuthorizer.js';
import { SwigSessionAuthorizer } from '../session/authorizers/SwigSessionAuthorizer.js';
import { UnboundedAuthorizer } from '../session/authorizers/UnboundedAuthorizer.js';

let signer: MessagePartialSigner;

beforeEach(async () => {
    signer = await generateKeyPairSigner();
});

describe('wallet-manual profile', () => {
    test('creates an UnboundedAuthorizer', () => {
        const auth = makeSessionAuthorizer({
            profile: {
                profile: 'wallet-manual',
                requireApprovalOnEveryUpdate: false,
            },
            signer,
            buildOpenTx: async () => 'tx',
        });

        expect(auth).toBeInstanceOf(UnboundedAuthorizer);
        expect(auth.getMode()).toBe('regular_unbounded');
    });

    test('passes requireApprovalOnEveryUpdate through', () => {
        const auth = makeSessionAuthorizer({
            profile: {
                profile: 'wallet-manual',
                requireApprovalOnEveryUpdate: true,
            },
            signer,
        });

        const caps = auth.getCapabilities();
        expect(caps.requiresInteractiveApproval.update).toBe(true);
    });

    test('throws when signer is missing', () => {
        expect(() =>
            makeSessionAuthorizer({
                profile: {
                    profile: 'wallet-manual',
                    requireApprovalOnEveryUpdate: false,
                },
            }),
        ).toThrow(/signer/);
    });
});

describe('wallet-budget profile', () => {
    test('creates a BudgetAuthorizer', () => {
        const auth = makeSessionAuthorizer({
            profile: {
                profile: 'wallet-budget',
                maxCumulativeAmount: '10000',
            },
            signer,
            swigWallet: {
                address: 'wallet-addr',
                swigAddress: 'SwigAddr1111111111111111111111111111111111',
                swigRoleId: 1,
            },
            buildOpenTx: async () => 'tx',
        });

        expect(auth).toBeInstanceOf(BudgetAuthorizer);
        expect(auth.getMode()).toBe('regular_budget');
    });

    test('throws when signer is missing', () => {
        expect(() =>
            makeSessionAuthorizer({
                profile: {
                    profile: 'wallet-budget',
                    maxCumulativeAmount: '10000',
                },
                swigWallet: {
                    address: 'w',
                    swigAddress: 'SwigAddr',
                    swigRoleId: 1,
                },
            }),
        ).toThrow(/signer/);
    });

    test('throws when swigWallet.swigAddress is missing', () => {
        expect(() =>
            makeSessionAuthorizer({
                profile: {
                    profile: 'wallet-budget',
                    maxCumulativeAmount: '10000',
                },
                signer,
                swigWallet: {
                    address: 'w',
                    // swigAddress intentionally omitted
                } as any,
            }),
        ).toThrow(/swigAddress/);
    });

    test('throws when swigWallet.swigRoleId is missing', () => {
        expect(() =>
            makeSessionAuthorizer({
                profile: {
                    profile: 'wallet-budget',
                    maxCumulativeAmount: '10000',
                },
                signer,
                swigWallet: {
                    address: 'w',
                    swigAddress: 'SwigAddr',
                    // swigRoleId intentionally omitted
                } as any,
            }),
        ).toThrow(/swigRoleId/);
    });
});

describe('swig-time-bound profile', () => {
    test('creates a SwigSessionAuthorizer', () => {
        const auth = makeSessionAuthorizer({
            profile: {
                profile: 'swig-time-bound',
                ttlSeconds: 3600,
            },
            swigWallet: {
                address: 'wallet-addr',
                swigAddress: 'SwigAddr1111111111111111111111111111111111',
                swigRoleId: 1,
                createSessionKey: async () => ({
                    signer: await generateKeyPairSigner(),
                    openTx: 'open-tx',
                }),
            },
        });

        expect(auth).toBeInstanceOf(SwigSessionAuthorizer);
        expect(auth.getMode()).toBe('swig_session');
    });

    test('throws when swigWallet is missing', () => {
        expect(() =>
            makeSessionAuthorizer({
                profile: {
                    profile: 'swig-time-bound',
                    ttlSeconds: 3600,
                },
            }),
        ).toThrow(/swigWallet/);
    });
});
