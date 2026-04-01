import { test, expect, describe } from 'vitest';
import { toAtomicUnits } from '../utils/amounts.js';

describe('toAtomicUnits', () => {
    // ── Integer amounts (already atomic) ──

    test('integer string passes through as BigInt', () => {
        expect(toAtomicUnits('1000')).toBe(1000n);
    });

    test('large integer string', () => {
        expect(toAtomicUnits('1000000000')).toBe(1000000000n);
    });

    test('zero', () => {
        expect(toAtomicUnits('0')).toBe(0n);
    });

    test('integer string ignores decimals param', () => {
        expect(toAtomicUnits('1000', 6)).toBe(1000n);
    });

    // ── Decimal amounts (human-readable) ──

    test('decimal USDC amount with 6 decimals', () => {
        // 0.001 USDC = 1000 micro-units (QuickNode MPP format)
        expect(toAtomicUnits('0.001', 6)).toBe(1000n);
    });

    test('decimal SOL amount with 9 decimals', () => {
        // 1.5 SOL = 1_500_000_000 lamports
        expect(toAtomicUnits('1.5', 9)).toBe(1500000000n);
    });

    test('decimal with exact precision', () => {
        // 0.000001 USDC = 1 micro-unit
        expect(toAtomicUnits('0.000001', 6)).toBe(1n);
    });

    test('decimal with fewer fractional digits pads with zeros', () => {
        // 0.1 USDC = 100000 micro-units
        expect(toAtomicUnits('0.1', 6)).toBe(100000n);
    });

    test('whole number with decimal point', () => {
        // 1.000000 USDC = 1000000 micro-units
        expect(toAtomicUnits('1.000000', 6)).toBe(1000000n);
    });

    test('5 decimals (e.g. BONK)', () => {
        expect(toAtomicUnits('0.5', 5)).toBe(50000n);
    });

    test('4 decimals', () => {
        expect(toAtomicUnits('0.25', 4)).toBe(2500n);
    });

    // ── Error cases ──

    test('decimal without decimals param throws', () => {
        expect(() => toAtomicUnits('0.001')).toThrow(
            'contains a decimal but no "decimals" field was provided',
        );
    });

    test('decimal with undefined decimals throws', () => {
        expect(() => toAtomicUnits('0.001', undefined)).toThrow(
            'contains a decimal but no "decimals" field was provided',
        );
    });

    test('excess precision throws instead of silently truncating', () => {
        // 0.0000001 has 7 fractional digits but USDC only supports 6
        expect(() => toAtomicUnits('0.0000001', 6)).toThrow(
            'has 7 fractional digits, but token only supports 6 decimals',
        );
    });

    test('invalid format with multiple dots throws', () => {
        expect(() => toAtomicUnits('1.2.3', 6)).toThrow('Invalid amount format');
    });
});
