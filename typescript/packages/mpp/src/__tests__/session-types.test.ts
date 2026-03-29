/**
 * Tests for session/Types.ts — compile-time type coverage and runtime validation
 * of type shapes used throughout the session module.
 *
 * These tests verify the structural contracts of the TypeScript interfaces by
 * constructing valid and invalid payloads at runtime.
 */
import type {
    AuthorizationMode,
    AuthorizerCapabilities,
    ChannelState,
    SessionCredentialPayload,
    SessionPolicyProfile,
    SessionVoucher,
    SignedSessionVoucher,
} from '../session/Types.js';

describe('AuthorizationMode', () => {
    test('accepts valid modes', () => {
        const modes: AuthorizationMode[] = ['regular_budget', 'regular_unbounded', 'swig_session'];
        expect(modes).toHaveLength(3);
    });
});

describe('SessionVoucher structure', () => {
    test('can construct a minimal voucher', () => {
        const voucher: SessionVoucher = {
            chainId: 'solana:devnet',
            channelId: 'ch-1',
            channelProgram: 'prog-addr',
            cumulativeAmount: '100',
            meter: 'api_calls',
            payer: 'payer-addr',
            recipient: 'recipient-addr',
            sequence: 1,
            serverNonce: 'nonce-1',
            units: '1',
        };

        expect(voucher.channelId).toBe('ch-1');
        expect(voucher.sequence).toBe(1);
    });

    test('supports optional expiresAt', () => {
        const voucher: SessionVoucher = {
            chainId: 'solana:devnet',
            channelId: 'ch-2',
            channelProgram: 'prog-addr',
            cumulativeAmount: '0',
            expiresAt: '2030-01-01T00:00:00.000Z',
            meter: 'session',
            payer: 'payer',
            recipient: 'recipient',
            sequence: 0,
            serverNonce: 'nonce',
            units: '0',
        };

        expect(voucher.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    });
});

describe('SignedSessionVoucher structure', () => {
    test('can construct a signed voucher with ed25519', () => {
        const signed: SignedSessionVoucher = {
            signature: 'base58sig',
            signatureType: 'ed25519',
            signer: 'signer-addr',
            voucher: {
                chainId: 'solana:devnet',
                channelId: 'ch-1',
                channelProgram: 'prog',
                cumulativeAmount: '0',
                meter: 'api',
                payer: 'payer',
                recipient: 'recipient',
                sequence: 0,
                serverNonce: 'nonce',
                units: '0',
            },
        };

        expect(signed.signatureType).toBe('ed25519');
    });

    test('can construct with swig-session signatureType', () => {
        const signed: SignedSessionVoucher = {
            signature: 'sig',
            signatureType: 'swig-session',
            signer: 'signer',
            voucher: {
                chainId: 'solana:devnet',
                channelId: 'ch-2',
                channelProgram: 'prog',
                cumulativeAmount: '100',
                meter: 'api',
                payer: 'payer',
                recipient: 'recipient',
                sequence: 1,
                serverNonce: 'nonce',
                units: '1',
            },
        };

        expect(signed.signatureType).toBe('swig-session');
    });
});

describe('ChannelState structure', () => {
    test('can construct a full channel state', () => {
        const state: ChannelState = {
            asset: { decimals: 9, kind: 'sol' },
            authority: { wallet: 'wallet-addr' },
            authorizationMode: 'regular_unbounded',
            channelId: 'ch-1',
            createdAt: '2025-01-01T00:00:00.000Z',
            escrowedAmount: '1000',
            expiresAtUnix: null,
            lastAuthorizedAmount: '500',
            lastSequence: 3,
            openSlot: 100,
            payer: 'payer-addr',
            recipient: 'recipient-addr',
            serverNonce: 'nonce',
            settledAmount: '200',
            status: 'open',
        };

        expect(state.status).toBe('open');
        expect(state.expiresAtUnix).toBeNull();
    });

    test('supports all status values', () => {
        const statuses: ChannelState['status'][] = ['open', 'closing', 'closed', 'expired'];
        expect(statuses).toHaveLength(4);
    });

    test('supports delegatedSessionKey and swigRoleId in authority', () => {
        const state: ChannelState = {
            asset: { decimals: 6, kind: 'spl', mint: 'USDC_MINT' },
            authority: {
                delegatedSessionKey: 'session-key',
                swigRoleId: 42,
                wallet: 'wallet',
            },
            authorizationMode: 'swig_session',
            channelId: 'ch-swig',
            createdAt: '2025-06-01T00:00:00.000Z',
            escrowedAmount: '500',
            expiresAtUnix: 1735689600,
            lastAuthorizedAmount: '0',
            lastSequence: 0,
            openSlot: 200,
            payer: 'payer',
            recipient: 'recipient',
            serverNonce: 'nonce',
            settledAmount: '0',
            status: 'open',
        };

        expect(state.authority.delegatedSessionKey).toBe('session-key');
        expect(state.authority.swigRoleId).toBe(42);
    });
});

describe('SessionCredentialPayload structure', () => {
    test('open payload includes all required fields', () => {
        const payload: SessionCredentialPayload = {
            action: 'open',
            authorizationMode: 'regular_unbounded',
            channelId: 'ch-1',
            depositAmount: '1000',
            openTx: 'tx-hash',
            payer: 'payer-addr',
            voucher: {
                signature: 'sig',
                signatureType: 'ed25519',
                signer: 'signer',
                voucher: {
                    chainId: 'solana:devnet',
                    channelId: 'ch-1',
                    channelProgram: 'prog',
                    cumulativeAmount: '0',
                    meter: 'session',
                    payer: 'payer-addr',
                    recipient: 'recipient',
                    sequence: 0,
                    serverNonce: 'nonce',
                    units: '0',
                },
            },
        };

        expect(payload.action).toBe('open');
    });

    test('update payload has minimal fields', () => {
        const payload: SessionCredentialPayload = {
            action: 'update',
            channelId: 'ch-1',
            voucher: {
                signature: 'sig',
                signatureType: 'ed25519',
                signer: 'signer',
                voucher: {
                    chainId: 'solana:devnet',
                    channelId: 'ch-1',
                    channelProgram: 'prog',
                    cumulativeAmount: '300',
                    meter: 'api',
                    payer: 'payer',
                    recipient: 'recipient',
                    sequence: 2,
                    serverNonce: 'nonce',
                    units: '1',
                },
            },
        };

        expect(payload.action).toBe('update');
    });

    test('topup payload includes additionalAmount and topupTx', () => {
        const payload: SessionCredentialPayload = {
            action: 'topup',
            additionalAmount: '500',
            channelId: 'ch-1',
            topupTx: 'topup-tx-hash',
        };

        expect(payload.action).toBe('topup');
        expect(payload.additionalAmount).toBe('500');
    });

    test('close payload supports optional closeTx', () => {
        const payload: SessionCredentialPayload = {
            action: 'close',
            channelId: 'ch-1',
            voucher: {
                signature: 'sig',
                signatureType: 'ed25519',
                signer: 'signer',
                voucher: {
                    chainId: 'solana:devnet',
                    channelId: 'ch-1',
                    channelProgram: 'prog',
                    cumulativeAmount: '450',
                    meter: 'close',
                    payer: 'payer',
                    recipient: 'recipient',
                    sequence: 5,
                    serverNonce: 'nonce',
                    units: '0',
                },
            },
        };

        expect(payload.action).toBe('close');
        expect(payload.closeTx).toBeUndefined();
    });
});

describe('SessionPolicyProfile', () => {
    test('wallet-budget profile', () => {
        const profile: SessionPolicyProfile = {
            maxCumulativeAmount: '10000',
            profile: 'wallet-budget',
        };
        expect(profile.profile).toBe('wallet-budget');
    });

    test('wallet-manual profile', () => {
        const profile: SessionPolicyProfile = {
            profile: 'wallet-manual',
            requireApprovalOnEveryUpdate: true,
        };
        expect(profile.profile).toBe('wallet-manual');
    });

    test('swig-time-bound profile', () => {
        const profile: SessionPolicyProfile = {
            profile: 'swig-time-bound',
            ttlSeconds: 3600,
        };
        expect(profile.profile).toBe('swig-time-bound');
    });

    test('swig-time-bound with autoTopup config', () => {
        const profile: SessionPolicyProfile = {
            autoTopup: {
                amount: '1000',
                enabled: true,
                triggerBelow: '100',
            },
            profile: 'swig-time-bound',
            ttlSeconds: 7200,
        };
        expect(profile.autoTopup!.enabled).toBe(true);
    });
});

describe('AuthorizerCapabilities structure', () => {
    test('can construct complete capabilities', () => {
        const caps: AuthorizerCapabilities = {
            allowedActions: ['open', 'update', 'topup', 'close'],
            allowedPrograms: ['program-1'],
            expiresAt: '2030-01-01T00:00:00.000Z',
            maxCumulativeAmount: '10000',
            maxDepositAmount: '5000',
            mode: 'regular_budget',
            requiresInteractiveApproval: {
                close: false,
                open: false,
                topup: true,
                update: false,
            },
        };

        expect(caps.mode).toBe('regular_budget');
        expect(caps.requiresInteractiveApproval.topup).toBe(true);
    });
});
