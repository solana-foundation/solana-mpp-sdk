/**
 * Ed25519 precompile instruction builder.
 *
 * Constructs the instruction data for the Ed25519 precompile program
 * (Ed25519SigVerify111111111111111111111111111) to verify a signature
 * over an arbitrary message.
 *
 * The instruction data layout for a single signature (all inline):
 *   [0..2]    num_signatures: u16 LE = 1
 *   [2..4]    signature_offset: u16 LE = 16
 *   [4..6]    signature_instruction_index: u16 LE = 0xFFFF (same instruction)
 *   [6..8]    public_key_offset: u16 LE = 80
 *   [8..10]   public_key_instruction_index: u16 LE = 0xFFFF
 *   [10..12]  message_data_offset: u16 LE = 112
 *   [12..14]  message_data_size: u16 LE
 *   [14..16]  message_instruction_index: u16 LE = 0xFFFF
 *   [16..80]  signature: 64 bytes
 *   [80..112] public_key: 32 bytes
 *   [112..]   message: variable length
 */

import type { Address, Instruction } from '@solana/kit';

const ED25519_PROGRAM_ID = 'Ed25519SigVerify111111111111111111111111111' as Address;

const SAME_INSTRUCTION: number = 0xffff;
// Layout: 2 (num_sigs u16) + 14 (descriptor: 7 x u16) = 16 bytes header
const HEADER_SIZE = 16;
const SIGNATURE_SIZE = 64;
const PUBKEY_SIZE = 32;
const SIGNATURE_OFFSET = HEADER_SIZE;
const PUBKEY_OFFSET = SIGNATURE_OFFSET + SIGNATURE_SIZE;
const MESSAGE_OFFSET = PUBKEY_OFFSET + PUBKEY_SIZE;

/**
 * Build an Ed25519 precompile verify instruction.
 *
 * The instruction tells the precompile to verify that `signature` is a valid
 * Ed25519 signature of `message` by `publicKey`. The runtime verifies the
 * signature; our on-chain program then reads the instructions sysvar to
 * confirm the precompile was asked to verify the correct key and message.
 */
export function createEd25519VerifyInstruction(
    publicKey: Uint8Array,
    signature: Uint8Array,
    message: Uint8Array,
): Instruction {
    if (publicKey.length !== PUBKEY_SIZE) {
        throw new Error(`Public key must be ${PUBKEY_SIZE} bytes, got ${publicKey.length}`);
    }
    if (signature.length !== SIGNATURE_SIZE) {
        throw new Error(`Signature must be ${SIGNATURE_SIZE} bytes, got ${signature.length}`);
    }

    const totalSize = MESSAGE_OFFSET + message.length;
    const data = new Uint8Array(totalSize);
    const view = new DataView(data.buffer);

    // num_signatures
    view.setUint16(0, 1, true);

    // Descriptor (starts at offset 2, immediately after num_signatures)
    view.setUint16(2, SIGNATURE_OFFSET, true); // signature_offset
    view.setUint16(4, SAME_INSTRUCTION, true); // signature_instruction_index
    view.setUint16(6, PUBKEY_OFFSET, true); // public_key_offset
    view.setUint16(8, SAME_INSTRUCTION, true); // public_key_instruction_index
    view.setUint16(10, MESSAGE_OFFSET, true); // message_data_offset
    view.setUint16(12, message.length, true); // message_data_size
    view.setUint16(14, SAME_INSTRUCTION, true); // message_instruction_index

    // Data
    data.set(signature, SIGNATURE_OFFSET);
    data.set(publicKey, PUBKEY_OFFSET);
    data.set(message, MESSAGE_OFFSET);

    return {
        accounts: [],
        data,
        programAddress: ED25519_PROGRAM_ID,
    };
}
