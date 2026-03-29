/**
 * Tests for client/Methods.ts and client/index.ts exports.
 *
 * Validates that the client barrel modules expose the expected public API.
 */
import { solana } from '../client/Methods.js';
import { charge, solana as solanaFromIndex } from '../client/index.js';

describe('client/Methods.ts', () => {
    test('solana is a callable function', () => {
        expect(typeof solana).toBe('function');
    });

    test('solana.charge is a function', () => {
        expect(typeof solana.charge).toBe('function');
    });
});

describe('client/index.ts', () => {
    test('exports charge function', () => {
        expect(typeof charge).toBe('function');
    });

    test('exports solana namespace', () => {
        expect(typeof solanaFromIndex).toBe('function');
        expect(solanaFromIndex).toBe(solana);
    });
});
