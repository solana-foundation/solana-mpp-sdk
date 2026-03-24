import { type Address, address, getProgramDerivedAddress, type Instruction } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';

import { ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../constants.js';
import { createEd25519VerifyInstruction } from '../utils/ed25519.js';

const CHANNEL_SEED = 'mpp-channel';
const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');

// Anchor discriminators: sha256("global:<fn_name>")[0..8]
export const DISCRIMINATOR_OPEN = new Uint8Array([228, 220, 155, 71, 199, 189, 60, 45]);
export const DISCRIMINATOR_TOP_UP = new Uint8Array([236, 225, 96, 9, 60, 106, 77, 208]);
const DISCRIMINATOR_SETTLE = new Uint8Array([175, 42, 185, 87, 144, 131, 102, 212]);
const DISCRIMINATOR_CLOSE = new Uint8Array([98, 165, 201, 177, 108, 65, 206, 96]);
const DISCRIMINATOR_REQUEST_CLOSE = new Uint8Array([82, 168, 167, 86, 14, 15, 199, 180]);
const DISCRIMINATOR_WITHDRAW = new Uint8Array([183, 18, 70, 156, 148, 109, 161, 34]);

function addressToBytes(addr: Address): Uint8Array {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const bytes = new Uint8Array(32);
    let num = 0n;
    for (const char of addr) {
        const index = alphabet.indexOf(char);
        if (index === -1) throw new Error(`Invalid base58 character: ${char}`);
        num = num * 58n + BigInt(index);
    }
    for (let i = 31; i >= 0; i--) {
        bytes[i] = Number(num & 0xffn);
        num >>= 8n;
    }
    return bytes;
}

function writeU64LE(buf: Uint8Array, offset: number, value: bigint): void {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setBigUint64(offset, value, true);
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setUint32(offset, value, true);
}

// ---- PDA derivation ----

export async function deriveChannelPda(
    programId: Address,
    payer: Address,
    payee: Address,
    token: Address,
    salt: bigint,
    authorizedSigner: Address,
): Promise<readonly [Address, number]> {
    const saltBytes = new Uint8Array(8);
    writeU64LE(saltBytes, 0, salt);

    return await getProgramDerivedAddress({
        programAddress: programId,
        seeds: [
            CHANNEL_SEED,
            addressToBytes(payer),
            addressToBytes(payee),
            addressToBytes(token),
            saltBytes,
            addressToBytes(authorizedSigner),
        ],
    });
}

export async function deriveVaultPda(
    channelPda: Address,
    mint: Address,
    tokenProgram: Address = address(TOKEN_PROGRAM),
): Promise<Address> {
    const [vaultAddress] = await findAssociatedTokenPda({ mint, owner: channelPda, tokenProgram });
    return vaultAddress;
}

// ---- Instruction builders ----

export function buildOpenInstruction(params: {
    authorizedSigner: Address;
    channelPda: Address;
    deposit: bigint;
    gracePeriodSeconds: bigint;
    mint: Address;
    payee: Address;
    payer: Address;
    payerTokenAccount: Address;
    programId: Address;
    salt: bigint;
    tokenProgram?: Address;
    vault: Address;
}): Instruction {
    const tokenProgramAddr = params.tokenProgram ?? address(TOKEN_PROGRAM);
    const data = new Uint8Array(8 + 8 + 8 + 8 + 32);
    data.set(DISCRIMINATOR_OPEN, 0);
    writeU64LE(data, 8, params.salt);
    writeU64LE(data, 16, params.deposit);
    writeU64LE(data, 24, params.gracePeriodSeconds);
    data.set(addressToBytes(params.authorizedSigner), 32);

    return {
        accounts: [
            { address: params.payer, role: 3 }, // signer + writable
            { address: params.payee, role: 0 }, // readonly
            { address: params.mint, role: 0 }, // readonly
            { address: params.channelPda, role: 1 }, // writable
            { address: params.payerTokenAccount, role: 1 }, // writable
            { address: params.vault, role: 1 }, // writable
            { address: tokenProgramAddr, role: 0 }, // readonly
            { address: address(ASSOCIATED_TOKEN_PROGRAM), role: 0 },
            { address: address(SYSTEM_PROGRAM), role: 0 },
        ],
        data,
        programAddress: params.programId,
    };
}

export function buildSettleInstruction(params: {
    channelPda: Address;
    cumulativeAmount: bigint;
    ed25519InstructionIndex: number;
    mint: Address;
    payee: Address;
    payeeTokenAccount: Address;
    programId: Address;
    tokenProgram?: Address;
    vault: Address;
    voucherMessage: Uint8Array;
}): Instruction {
    const tokenProgramAddr = params.tokenProgram ?? address(TOKEN_PROGRAM);
    const messageLen = params.voucherMessage.length;
    const data = new Uint8Array(8 + 8 + 4 + messageLen + 1);
    data.set(DISCRIMINATOR_SETTLE, 0);
    writeU64LE(data, 8, params.cumulativeAmount);
    writeU32LE(data, 16, messageLen);
    data.set(params.voucherMessage, 20);
    data[20 + messageLen] = params.ed25519InstructionIndex;

    return {
        accounts: [
            { address: params.payee, role: 2 }, // signer
            { address: params.channelPda, role: 1 }, // writable
            { address: params.mint, role: 0 }, // readonly
            { address: params.vault, role: 1 }, // writable
            { address: params.payeeTokenAccount, role: 1 }, // writable
            { address: INSTRUCTIONS_SYSVAR, role: 0 }, // readonly
            { address: tokenProgramAddr, role: 0 }, // readonly
        ],
        data,
        programAddress: params.programId,
    };
}

export function buildCloseInstruction(params: {
    channelPda: Address;
    cumulativeAmount: bigint;
    ed25519InstructionIndex: number;
    mint: Address;
    payee: Address;
    payeeTokenAccount: Address;
    payerTokenAccount: Address;
    programId: Address;
    tokenProgram?: Address;
    vault: Address;
    voucherMessage: Uint8Array;
}): Instruction {
    const tokenProgramAddr = params.tokenProgram ?? address(TOKEN_PROGRAM);
    const messageLen = params.voucherMessage.length;
    const data = new Uint8Array(8 + 8 + 4 + messageLen + 1);
    data.set(DISCRIMINATOR_CLOSE, 0);
    writeU64LE(data, 8, params.cumulativeAmount);
    writeU32LE(data, 16, messageLen);
    data.set(params.voucherMessage, 20);
    data[20 + messageLen] = params.ed25519InstructionIndex;

    return {
        accounts: [
            { address: params.payee, role: 2 }, // signer
            { address: params.channelPda, role: 1 }, // writable
            { address: params.mint, role: 0 }, // readonly
            { address: params.vault, role: 1 }, // writable
            { address: params.payeeTokenAccount, role: 1 }, // writable
            { address: params.payerTokenAccount, role: 1 }, // writable
            { address: INSTRUCTIONS_SYSVAR, role: 0 }, // readonly
            { address: tokenProgramAddr, role: 0 }, // readonly
        ],
        data,
        programAddress: params.programId,
    };
}

export function buildTopUpInstruction(params: {
    amount: bigint;
    channelPda: Address;
    mint: Address;
    payer: Address;
    payerTokenAccount: Address;
    programId: Address;
    tokenProgram?: Address;
    vault: Address;
}): Instruction {
    const tokenProgramAddr = params.tokenProgram ?? address(TOKEN_PROGRAM);
    const data = new Uint8Array(8 + 8);
    data.set(DISCRIMINATOR_TOP_UP, 0);
    writeU64LE(data, 8, params.amount);

    return {
        accounts: [
            { address: params.payer, role: 2 }, // signer
            { address: params.channelPda, role: 1 }, // writable
            { address: params.mint, role: 0 }, // readonly
            { address: params.vault, role: 1 }, // writable
            { address: params.payerTokenAccount, role: 1 }, // writable
            { address: tokenProgramAddr, role: 0 }, // readonly
        ],
        data,
        programAddress: params.programId,
    };
}

export function buildRequestCloseInstruction(params: {
    channelPda: Address;
    payer: Address;
    programId: Address;
}): Instruction {
    const data = new Uint8Array(8);
    data.set(DISCRIMINATOR_REQUEST_CLOSE, 0);

    return {
        accounts: [
            { address: params.payer, role: 2 }, // signer
            { address: params.channelPda, role: 1 }, // writable
        ],
        data,
        programAddress: params.programId,
    };
}

export function buildWithdrawInstruction(params: {
    channelPda: Address;
    mint: Address;
    payer: Address;
    payerTokenAccount: Address;
    programId: Address;
    tokenProgram?: Address;
    vault: Address;
}): Instruction {
    const tokenProgramAddr = params.tokenProgram ?? address(TOKEN_PROGRAM);
    const data = new Uint8Array(8);
    data.set(DISCRIMINATOR_WITHDRAW, 0);

    return {
        accounts: [
            { address: params.payer, role: 2 }, // signer
            { address: params.channelPda, role: 1 }, // writable
            { address: params.mint, role: 0 }, // readonly
            { address: params.vault, role: 1 }, // writable
            { address: params.payerTokenAccount, role: 1 }, // writable
            { address: tokenProgramAddr, role: 0 }, // readonly
        ],
        data,
        programAddress: params.programId,
    };
}

// ---- Settle/Close transaction helpers ----

/**
 * Build the instructions for a settle transaction.
 *
 * Returns two instructions: an Ed25519 verify instruction (index 0)
 * followed by the settle instruction (index 1) that references it.
 */
export function buildSettleInstructions(params: {
    channelPda: Address;
    cumulativeAmount: bigint;
    mint: Address;
    payee: Address;
    payeeTokenAccount: Address;
    programId: Address;
    signature: Uint8Array;
    signerPublicKey: Uint8Array;
    tokenProgram?: Address;
    vault: Address;
    voucherMessage: Uint8Array;
}): Instruction[] {
    const ed25519Ix = createEd25519VerifyInstruction(params.signerPublicKey, params.signature, params.voucherMessage);

    const settleIx = buildSettleInstruction({
        ...params,
        ed25519InstructionIndex: 0,
    });

    return [ed25519Ix, settleIx];
}

/**
 * Build the instructions for a close transaction with a final voucher.
 *
 * Returns two instructions: Ed25519 verify (index 0) + close (index 1).
 * For cooperative close without a voucher, use buildCloseInstruction directly
 * with an empty voucherMessage and no Ed25519 instruction.
 */
export function buildCloseInstructions(params: {
    channelPda: Address;
    cumulativeAmount: bigint;
    mint: Address;
    payee: Address;
    payeeTokenAccount: Address;
    payerTokenAccount: Address;
    programId: Address;
    signature: Uint8Array;
    signerPublicKey: Uint8Array;
    tokenProgram?: Address;
    vault: Address;
    voucherMessage: Uint8Array;
}): Instruction[] {
    const ed25519Ix = createEd25519VerifyInstruction(params.signerPublicKey, params.signature, params.voucherMessage);

    const closeIx = buildCloseInstruction({
        ...params,
        ed25519InstructionIndex: 0,
    });

    return [ed25519Ix, closeIx];
}
