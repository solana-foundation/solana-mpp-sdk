/**
 * Tests for the root index.ts and session/index.ts barrel exports.
 *
 * Validates that the public API surface is properly exposed.
 */
import * as rootExports from '../index.js';
import * as sessionExports from '../session/index.js';
import * as clientIndex from '../client/index.js';
import * as serverIndex from '../server/index.js';
import * as authorizersIndex from '../session/authorizers/index.js';

describe('root index.ts exports', () => {
    test('exports charge method definition', () => {
        expect(rootExports.charge).toBeDefined();
    });

    test('exports session method definition', () => {
        expect(rootExports.session).toBeDefined();
    });

    test('exports BudgetAuthorizer class', () => {
        expect(rootExports.BudgetAuthorizer).toBeDefined();
        expect(typeof rootExports.BudgetAuthorizer).toBe('function');
    });

    test('exports UnboundedAuthorizer class', () => {
        expect(rootExports.UnboundedAuthorizer).toBeDefined();
        expect(typeof rootExports.UnboundedAuthorizer).toBe('function');
    });

    test('exports SwigSessionAuthorizer class', () => {
        expect(rootExports.SwigSessionAuthorizer).toBeDefined();
        expect(typeof rootExports.SwigSessionAuthorizer).toBe('function');
    });

    test('exports makeSessionAuthorizer factory', () => {
        expect(rootExports.makeSessionAuthorizer).toBeDefined();
        expect(typeof rootExports.makeSessionAuthorizer).toBe('function');
    });
});

describe('session/index.ts exports', () => {
    test('exports all Types', () => {
        // Types are type-only exports so they won't be present at runtime,
        // but the module itself should import without errors.
        expect(sessionExports).toBeDefined();
    });

    test('exports Voucher functions', () => {
        expect(typeof sessionExports.signVoucher).toBe('function');
        expect(typeof sessionExports.verifyVoucherSignature).toBe('function');
        expect(typeof sessionExports.serializeVoucher).toBe('function');
        expect(typeof sessionExports.parseVoucherFromPayload).toBe('function');
    });

    test('exports ChannelStore functions', () => {
        expect(typeof sessionExports.fromStore).toBe('function');
        expect(typeof sessionExports.deductFromChannel).toBe('function');
    });

    test('exports authorizer classes', () => {
        expect(typeof sessionExports.BudgetAuthorizer).toBe('function');
        expect(typeof sessionExports.UnboundedAuthorizer).toBe('function');
        expect(typeof sessionExports.SwigSessionAuthorizer).toBe('function');
        expect(typeof sessionExports.makeSessionAuthorizer).toBe('function');
    });
});

describe('client/index.ts re-exports', () => {
    test('exports charge', () => {
        expect(typeof clientIndex.charge).toBe('function');
    });

    test('exports session', () => {
        expect(typeof clientIndex.session).toBe('function');
    });

    test('exports solana', () => {
        expect(typeof clientIndex.solana).toBe('function');
    });
});

describe('server/index.ts re-exports', () => {
    test('exports charge', () => {
        expect(typeof serverIndex.charge).toBe('function');
    });

    test('exports session', () => {
        expect(typeof serverIndex.session).toBe('function');
    });

    test('exports solana', () => {
        expect(typeof serverIndex.solana).toBe('function');
    });

    test('exports Store', () => {
        expect(serverIndex.Store).toBeDefined();
    });
});

describe('session/authorizers/index.ts re-exports', () => {
    test('exports all authorizer classes', () => {
        expect(typeof authorizersIndex.BudgetAuthorizer).toBe('function');
        expect(typeof authorizersIndex.UnboundedAuthorizer).toBe('function');
        expect(typeof authorizersIndex.SwigSessionAuthorizer).toBe('function');
        expect(typeof authorizersIndex.makeSessionAuthorizer).toBe('function');
    });
});
