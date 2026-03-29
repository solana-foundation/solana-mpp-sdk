/**
 * Tests for the shared method schemas (Methods.ts).
 *
 * Validates that `charge` method definition has the expected
 * structure, intent, name, and schema shape.
 */
import { charge } from '../Methods.js';

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
