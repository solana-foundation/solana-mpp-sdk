/**
 * Tests for constants.ts — validates exported program addresses and RPC URL mappings.
 */
import {
    ASSOCIATED_TOKEN_PROGRAM,
    DEFAULT_RPC_URLS,
    SYSTEM_PROGRAM,
    TOKEN_2022_PROGRAM,
    TOKEN_PROGRAM,
    USDC,
} from '../constants.js';

describe('token program addresses', () => {
    test('TOKEN_PROGRAM is the expected base58 address', () => {
        expect(TOKEN_PROGRAM).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    });

    test('TOKEN_2022_PROGRAM is the expected base58 address', () => {
        expect(TOKEN_2022_PROGRAM).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    });

    test('ASSOCIATED_TOKEN_PROGRAM is the expected base58 address', () => {
        expect(ASSOCIATED_TOKEN_PROGRAM).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    });

    test('SYSTEM_PROGRAM is all ones', () => {
        expect(SYSTEM_PROGRAM).toBe('11111111111111111111111111111111');
    });
});

describe('USDC mint addresses', () => {
    test('has devnet mint', () => {
        expect(USDC.devnet).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    });

    test('has mainnet-beta mint', () => {
        expect(USDC['mainnet-beta']).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    });
});

describe('DEFAULT_RPC_URLS', () => {
    test('has devnet URL', () => {
        expect(DEFAULT_RPC_URLS.devnet).toBe('https://api.devnet.solana.com');
    });

    test('has mainnet-beta URL', () => {
        expect(DEFAULT_RPC_URLS['mainnet-beta']).toBe('https://api.mainnet-beta.solana.com');
    });

    test('has localnet URL', () => {
        expect(DEFAULT_RPC_URLS.localnet).toBe('http://localhost:8899');
    });
});
