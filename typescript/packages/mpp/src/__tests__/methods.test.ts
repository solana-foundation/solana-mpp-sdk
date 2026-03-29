/**
 * Tests for the shared method schemas (Methods.ts).
 *
 * Validates that `charge` and `session` method definitions have the expected
 * structure, intent, name, and schema shape.
 */
import { charge, session } from '../Methods.js';

describe('charge method definition', () => {
    test('has correct intent and name', () => {
        expect(charge.intent).toBe('charge');
        expect(charge.name).toBe('solana');
    });

    test('has request and credential schemas', () => {
        expect(charge.schema).toBeDefined();
        expect(charge.schema.request).toBeDefined();
        expect(charge.schema.credential).toBeDefined();
        expect(charge.schema.credential.payload).toBeDefined();
    });
});

describe('session method definition', () => {
    test('has correct intent and name', () => {
        expect(session.intent).toBe('session');
        expect(session.name).toBe('solana');
    });

    test('has request and credential schemas', () => {
        expect(session.schema).toBeDefined();
        expect(session.schema.request).toBeDefined();
        expect(session.schema.credential).toBeDefined();
        expect(session.schema.credential.payload).toBeDefined();
    });
});
