import { describe, expect, test } from 'vitest';

import {
    checkNetworkBlockhash,
    SURFPOOL_BLOCKHASH_PREFIX,
    WrongNetworkError,
} from '../server/network-check.js';

// Pure-function tests for the Surfpool-prefix-vs-non-localnet check.
// The check is asymmetric: a Surfpool-prefixed blockhash is only valid
// on `localnet`, but a non-prefixed blockhash is accepted on any network
// (we can't tell from a non-prefixed hash which real cluster it came from).

describe('checkNetworkBlockhash', () => {
    // ── happy paths ────────────────────────────────────────────────────────

    test('localnet + Surfpool-prefixed hash is ok', () => {
        expect(() =>
            checkNetworkBlockhash('localnet', 'SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1892bcad'),
        ).not.toThrow();
    });

    test('localnet + real hash is ok', () => {
        // Real localnet validator (not Surfpool) — also valid.
        expect(() =>
            checkNetworkBlockhash('localnet', '11111111111111111111111111111111'),
        ).not.toThrow();
    });

    test('mainnet + real hash is ok', () => {
        expect(() =>
            checkNetworkBlockhash('mainnet', '9zrUHnA1nCByPksy3aL8tQ47vqdaG2vnFs4HrxgcZj4F'),
        ).not.toThrow();
    });

    test('devnet + real hash is ok', () => {
        expect(() =>
            checkNetworkBlockhash('devnet', 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'),
        ).not.toThrow();
    });

    // ── the actual bug surface ─────────────────────────────────────────────

    test('mainnet rejects Surfpool-prefixed hash with explicit context', () => {
        let caught: unknown;
        try {
            checkNetworkBlockhash('mainnet', 'SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1892bcad');
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(WrongNetworkError);
        const err = caught as WrongNetworkError;
        expect(err.code).toBe('wrong-network');
        expect(err.expected).toBe('mainnet');
        expect(err.received).toBe('localnet');
        expect(err.message).toContain('Signed against localnet');
        expect(err.message).toContain('server expects mainnet');
        expect(err.message).toContain('re-sign');
        // Structured blockhash field is preserved for tooling even
        // though the message text doesn't include it.
        expect(err.blockhash).toBe('SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1892bcad');
    });

    test('devnet rejects Surfpool-prefixed hash', () => {
        expect(() =>
            checkNetworkBlockhash('devnet', 'SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1892bcad'),
        ).toThrow(WrongNetworkError);
    });

    // ── edge cases ─────────────────────────────────────────────────────────

    test('partial prefix (SURFNETx alone) does NOT match', () => {
        expect(() =>
            checkNetworkBlockhash('mainnet', 'SURFNETx9zrUHnA1nCByPksy'),
        ).not.toThrow();
    });

    test('exact prefix only is treated as Surfpool', () => {
        expect(() => checkNetworkBlockhash('localnet', SURFPOOL_BLOCKHASH_PREFIX)).not.toThrow();
        expect(() => checkNetworkBlockhash('mainnet', SURFPOOL_BLOCKHASH_PREFIX)).toThrow(
            WrongNetworkError,
        );
    });

    test('non-Surfpool hash passes on every network (asymmetric design)', () => {
        for (const network of ['mainnet', 'devnet', 'localnet']) {
            expect(() =>
                checkNetworkBlockhash(network, '11111111111111111111111111111111'),
            ).not.toThrow();
        }
    });
});
