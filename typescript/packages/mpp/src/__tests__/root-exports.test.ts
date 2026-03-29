/**
 * Tests for the root index.ts barrel exports.
 *
 * Validates that the public API surface is properly exposed.
 */
import * as rootExports from '../index.js';
import * as clientIndex from '../client/index.js';
import * as serverIndex from '../server/index.js';

describe('root index.ts exports', () => {
    test('exports charge method definition', () => {
        expect(rootExports.charge).toBeDefined();
    });
});

describe('client/index.ts re-exports', () => {
    test('exports charge', () => {
        expect(typeof clientIndex.charge).toBe('function');
    });

    test('exports solana', () => {
        expect(typeof clientIndex.solana).toBe('function');
    });
});

describe('server/index.ts re-exports', () => {
    test('exports charge', () => {
        expect(typeof serverIndex.charge).toBe('function');
    });

    test('exports solana', () => {
        expect(typeof serverIndex.solana).toBe('function');
    });

    test('exports Store', () => {
        expect(serverIndex.Store).toBeDefined();
    });
});
