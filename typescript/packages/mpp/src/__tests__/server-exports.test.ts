/**
 * Tests for server/Methods.ts and server/index.ts exports.
 *
 * Validates that the server barrel modules expose the expected public API.
 */
import { Store } from 'mppx/server';

import { solana } from '../server/Methods.js';
import { charge, session, solana as solanaFromIndex } from '../server/index.js';

const RECIPIENT = '9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ';

describe('server/Methods.ts', () => {
    test('solana is a callable function', () => {
        expect(typeof solana).toBe('function');
    });

    test('solana.charge is a function', () => {
        expect(typeof solana.charge).toBe('function');
    });

    test('solana.session is a function', () => {
        expect(typeof solana.session).toBe('function');
    });

    test('solana() creates a charge method (default)', () => {
        const method = solana({
            recipient: RECIPIENT,
            network: 'devnet',
            store: Store.memory(),
        });

        expect(method).toBeDefined();
        expect(typeof method.verify).toBe('function');
    });

    test('solana.charge() creates a charge method', () => {
        const method = solana.charge({
            recipient: RECIPIENT,
            network: 'devnet',
            store: Store.memory(),
        });

        expect(method).toBeDefined();
        expect(typeof method.verify).toBe('function');
    });
});

describe('server/index.ts', () => {
    test('exports charge function', () => {
        expect(typeof charge).toBe('function');
    });

    test('exports session function', () => {
        expect(typeof session).toBe('function');
    });

    test('exports solana namespace', () => {
        expect(typeof solanaFromIndex).toBe('function');
        expect(solanaFromIndex).toBe(solana);
    });
});
