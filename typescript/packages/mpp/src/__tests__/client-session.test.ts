/**
 * Tests for client/Session.ts — validates the session context schema and
 * the exported `session` function's basic structure.
 *
 * The actual createCredential logic requires a real SessionAuthorizer and
 * is tested indirectly through the authorizer tests. Here we test the
 * schema validation and function creation.
 */
import { generateKeyPairSigner } from '@solana/kit';

import { session, sessionContextSchema } from '../client/Session.js';
import { UnboundedAuthorizer } from '../session/authorizers/UnboundedAuthorizer.js';

describe('sessionContextSchema', () => {
    test('accepts a valid open context', () => {
        const result = sessionContextSchema.parse({
            action: 'open',
            channelId: 'ch-1',
            depositAmount: '1000',
            openTx: 'tx-hash',
        });

        expect(result.action).toBe('open');
        expect(result.channelId).toBe('ch-1');
        expect(result.depositAmount).toBe('1000');
    });

    test('accepts a valid update context', () => {
        const result = sessionContextSchema.parse({
            action: 'update',
            channelId: 'ch-1',
            cumulativeAmount: '300',
            sequence: 2,
        });

        expect(result.action).toBe('update');
        expect(result.cumulativeAmount).toBe('300');
        expect(result.sequence).toBe(2);
    });

    test('accepts a valid topup context', () => {
        const result = sessionContextSchema.parse({
            action: 'topup',
            channelId: 'ch-1',
            additionalAmount: '500',
            topupTx: 'topup-tx',
        });

        expect(result.action).toBe('topup');
    });

    test('accepts a valid close context', () => {
        const result = sessionContextSchema.parse({
            action: 'close',
            channelId: 'ch-1',
        });

        expect(result.action).toBe('close');
    });

    test('accepts an empty context (implicit auto-open)', () => {
        const result = sessionContextSchema.parse({});
        expect(result.action).toBeUndefined();
    });

    test('accepts undefined for all optional fields', () => {
        const result = sessionContextSchema.parse({
            action: undefined,
            channelId: undefined,
        });

        expect(result.action).toBeUndefined();
    });
});

describe('session() function creation', () => {
    test('creates a method with createCredential', async () => {
        const signer = await generateKeyPairSigner();
        const authorizer = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        const method = session({
            authorizer,
            signer,
        });

        expect(method).toBeDefined();
    });

    test('creates a method without signer', async () => {
        const signer = await generateKeyPairSigner();
        const authorizer = new UnboundedAuthorizer({
            signer,
            buildOpenTx: async () => 'tx',
        });

        const method = session({
            authorizer,
        });

        expect(method).toBeDefined();
    });
});
