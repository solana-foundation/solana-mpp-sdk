/**
 * Parse a human-readable or atomic amount string into raw token units (BigInt).
 *
 * MPP servers may send amounts in two formats:
 *   - Atomic units: "1000" (already in smallest denomination)
 *   - Human-readable decimals: "0.001" (needs conversion using token decimals)
 *
 * When the amount contains a decimal point, `decimals` is required to convert.
 * Throws if the amount has more fractional digits than the token supports,
 * preventing silent truncation that could misprice payments.
 *
 * Based on `parseAmount` from `solana-mpp` (sendaifun/solana-mpp), adapted
 * for the `@solana/kit`-based client.
 *
 * @param value - The amount string from the MPP challenge.
 * @param decimals - The token's decimal precision (from `methodDetails.decimals`).
 * @returns The amount in atomic units as a BigInt.
 *
 * @example
 * ```ts
 * toAtomicUnits('1000')        // 1000n  (already atomic)
 * toAtomicUnits('0.001', 6)    // 1000n  (0.001 USDC → 1000 micro-units)
 * toAtomicUnits('1.5', 9)      // 1500000000n  (1.5 SOL → lamports)
 * toAtomicUnits('100', 6)      // 100n   (no decimal → passthrough)
 * ```
 */
export function toAtomicUnits(value: string, decimals?: number): bigint {
    if (!value.includes('.')) return BigInt(value);

    if (decimals == null) {
        throw new Error(
            `Amount "${value}" contains a decimal but no "decimals" field was provided. ` +
                'Cannot convert to atomic units without knowing the token\'s decimal precision.',
        );
    }

    const parts = value.split('.');
    if (parts.length > 2) {
        throw new Error(`Invalid amount format: "${value}"`);
    }

    const whole = parts[0] ?? '0';
    const frac = parts[1] ?? '';

    if (frac.length > decimals) {
        throw new Error(
            `Amount "${value}" has ${frac.length} fractional digits, but token only supports ${decimals} decimals`,
        );
    }

    const paddedFrac = frac.padEnd(decimals, '0');
    return BigInt(whole + paddedFrac);
}
