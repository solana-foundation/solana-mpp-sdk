/**
 * Tests for session/Voucher.ts — serialization, signing, verification, and parsing.
 */
import { generateKeyPairSigner } from '@solana/kit';

import type { SessionVoucher, SignedSessionVoucher } from '../session/Types.js';
import {
    parseVoucherFromPayload,
    serializeVoucher,
    signVoucher,
    verifyVoucherSignature,
} from '../session/Voucher.js';

const SAMPLE_VOUCHER: SessionVoucher = {
    chainId: 'solana:devnet',
    channelId: 'channel-abc',
    channelProgram: 'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB',
    cumulativeAmount: '500',
    meter: 'api_calls',
    payer: '9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ',
    recipient: 'BpfLoader2111111111111111111111111111111111',
    sequence: 3,
    serverNonce: 'nonce-123',
    units: '1',
};

describe('serializeVoucher', () => {
    test('returns Uint8Array prefixed with domain separator', () => {
        const bytes = serializeVoucher(SAMPLE_VOUCHER);
        expect(bytes).toBeInstanceOf(Uint8Array);
        const text = new TextDecoder().decode(bytes);
        expect(text.startsWith('solana-mpp-session-voucher-v1:')).toBe(true);
    });

    test('produces deterministic output for the same voucher', () => {
        const a = serializeVoucher(SAMPLE_VOUCHER);
        const b = serializeVoucher(SAMPLE_VOUCHER);
        expect(a).toEqual(b);
    });

    test('canonicalizes keys in sorted order', () => {
        const bytes = serializeVoucher(SAMPLE_VOUCHER);
        const text = new TextDecoder().decode(bytes);
        const jsonPart = text.slice('solana-mpp-session-voucher-v1:'.length);
        const parsed = JSON.parse(jsonPart);
        const keys = Object.keys(parsed);
        const sortedKeys = [...keys].sort();
        expect(keys).toEqual(sortedKeys);
    });

    test('strips undefined fields during canonicalization', () => {
        const voucherWithUndefined: SessionVoucher = {
            ...SAMPLE_VOUCHER,
            expiresAt: undefined,
        };
        const bytes = serializeVoucher(voucherWithUndefined);
        const text = new TextDecoder().decode(bytes);
        expect(text).not.toContain('expiresAt');
    });

    test('includes expiresAt when defined', () => {
        const voucherWithExpiry: SessionVoucher = {
            ...SAMPLE_VOUCHER,
            expiresAt: '2025-12-31T00:00:00.000Z',
        };
        const bytes = serializeVoucher(voucherWithExpiry);
        const text = new TextDecoder().decode(bytes);
        expect(text).toContain('expiresAt');
    });
});

describe('signVoucher', () => {
    test('signs a voucher and returns a SignedSessionVoucher', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);

        expect(signed.signature).toBeTruthy();
        expect(typeof signed.signature).toBe('string');
        expect(signed.signatureType).toBe('ed25519');
        expect(signed.signer).toBe(signer.address);
        expect(signed.voucher).toEqual(SAMPLE_VOUCHER);
    });

    test('produces different signatures for different vouchers', async () => {
        const signer = await generateKeyPairSigner();
        const signed1 = await signVoucher(signer, SAMPLE_VOUCHER);
        const signed2 = await signVoucher(signer, {
            ...SAMPLE_VOUCHER,
            cumulativeAmount: '999',
        });

        expect(signed1.signature).not.toBe(signed2.signature);
    });

    test('produces different signatures for different signers', async () => {
        const signer1 = await generateKeyPairSigner();
        const signer2 = await generateKeyPairSigner();
        const signed1 = await signVoucher(signer1, SAMPLE_VOUCHER);
        const signed2 = await signVoucher(signer2, SAMPLE_VOUCHER);

        expect(signed1.signature).not.toBe(signed2.signature);
    });
});

describe('verifyVoucherSignature', () => {
    test('returns true for a valid ed25519 signature', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);

        const valid = await verifyVoucherSignature(signed);
        expect(valid).toBe(true);
    });

    test('returns true for a swig-session signatureType with valid signature', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);
        // signVoucher defaults to ed25519, override to swig-session for testing
        const swigSigned: SignedSessionVoucher = {
            ...signed,
            signatureType: 'swig-session',
        };

        const valid = await verifyVoucherSignature(swigSigned);
        expect(valid).toBe(true);
    });

    test('returns false for a tampered signature', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);
        const tampered: SignedSessionVoucher = {
            ...signed,
            signature: signed.signature + 'TAMPERED',
        };

        const valid = await verifyVoucherSignature(tampered);
        expect(valid).toBe(false);
    });

    test('returns false for a tampered voucher body', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);
        const tampered: SignedSessionVoucher = {
            ...signed,
            voucher: { ...signed.voucher, cumulativeAmount: '999999' },
        };

        const valid = await verifyVoucherSignature(tampered);
        expect(valid).toBe(false);
    });

    test('returns false for unknown signatureType', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);
        const unknown: SignedSessionVoucher = {
            ...signed,
            signatureType: 'unknown-type' as any,
        };

        const valid = await verifyVoucherSignature(unknown);
        expect(valid).toBe(false);
    });

    test('returns false for a wrong signer address', async () => {
        const signer = await generateKeyPairSigner();
        const wrongSigner = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);
        const wrongAddress: SignedSessionVoucher = {
            ...signed,
            signer: wrongSigner.address,
        };

        const valid = await verifyVoucherSignature(wrongAddress);
        expect(valid).toBe(false);
    });
});

describe('parseVoucherFromPayload', () => {
    test('parses a signed voucher from a flat payload', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);

        const parsed = parseVoucherFromPayload(signed);
        expect(parsed.signature).toBe(signed.signature);
        expect(parsed.signatureType).toBe('ed25519');
        expect(parsed.signer).toBe(signer.address);
        expect(parsed.voucher.channelId).toBe(SAMPLE_VOUCHER.channelId);
        expect(parsed.voucher.cumulativeAmount).toBe(SAMPLE_VOUCHER.cumulativeAmount);
        expect(parsed.voucher.sequence).toBe(SAMPLE_VOUCHER.sequence);
    });

    test('parses a signed voucher nested under `voucher` key', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);

        // Wrap in a payload where the signed voucher is under `voucher`
        const payload = { voucher: signed };
        const parsed = parseVoucherFromPayload(payload);
        expect(parsed.signature).toBe(signed.signature);
        expect(parsed.voucher.channelId).toBe(SAMPLE_VOUCHER.channelId);
    });

    test('handles expiresAt field', async () => {
        const signer = await generateKeyPairSigner();
        const voucherWithExpiry: SessionVoucher = {
            ...SAMPLE_VOUCHER,
            expiresAt: '2025-12-31T00:00:00.000Z',
        };
        const signed = await signVoucher(signer, voucherWithExpiry);
        const parsed = parseVoucherFromPayload(signed);
        expect(parsed.voucher.expiresAt).toBe('2025-12-31T00:00:00.000Z');
    });

    test('omits expiresAt when absent', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);
        const parsed = parseVoucherFromPayload(signed);
        expect(parsed.voucher.expiresAt).toBeUndefined();
    });

    test('throws on non-object payload', () => {
        expect(() => parseVoucherFromPayload(null)).toThrow();
        expect(() => parseVoucherFromPayload(undefined)).toThrow();
        expect(() => parseVoucherFromPayload('string')).toThrow();
        expect(() => parseVoucherFromPayload(42)).toThrow();
    });

    test('throws when signatureType is invalid', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);
        const bad = { ...signed, signatureType: 'rsa' };
        expect(() => parseVoucherFromPayload(bad)).toThrow(/signatureType/);
    });

    test('throws when required string field is missing', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);
        const missingChannelId = {
            ...signed,
            voucher: { ...signed.voucher, channelId: undefined },
        };
        expect(() => parseVoucherFromPayload(missingChannelId)).toThrow(/channelId/);
    });

    test('throws when sequence is not an integer', async () => {
        const signer = await generateKeyPairSigner();
        const signed = await signVoucher(signer, SAMPLE_VOUCHER);
        const badSequence = {
            ...signed,
            voucher: { ...signed.voucher, sequence: 3.5 },
        };
        expect(() => parseVoucherFromPayload(badSequence)).toThrow(/sequence/);
    });
});
