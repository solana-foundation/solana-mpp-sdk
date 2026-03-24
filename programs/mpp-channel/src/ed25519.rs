use anchor_lang::prelude::*;

use crate::errors::MppChannelError;

// Ed25519 instruction data layout offsets (for a single signature).
// See: https://docs.solanalabs.com/runtime/programs#ed25519-program
//
// Header:
//   [0..2]   num_signatures (u16 LE) = 1
//   [2..4]   padding (u16 LE) = 0
//
// Per-signature descriptor (16 bytes):
//   [4..6]   signature_offset (u16 LE)
//   [6..8]   signature_instruction_index (u16 LE) = 0xFFFF (same instruction)
//   [8..10]  public_key_offset (u16 LE)
//   [10..12] public_key_instruction_index (u16 LE) = 0xFFFF
//   [12..14] message_data_offset (u16 LE)
//   [14..16] message_data_size (u16 LE)
//   [16..18] message_instruction_index (u16 LE) = 0xFFFF
//
// Padding:
// Data (for inline, all in same instruction):
//   [16..80]  signature (64 bytes)
//   [80..112] public_key (32 bytes)
//   [112..]   message (variable)

const HEADER_SIZE: usize = 2; // num_signatures u16
const DESCRIPTOR_SIZE: usize = 14; // 7 x u16 fields

const SIGNATURE_SIZE: usize = 64;
const PUBKEY_SIZE: usize = 32;

const DATA_START: usize = HEADER_SIZE + DESCRIPTOR_SIZE; // 16
const SIGNATURE_OFFSET: usize = DATA_START;
const PUBKEY_OFFSET: usize = SIGNATURE_OFFSET + SIGNATURE_SIZE;
const MESSAGE_OFFSET: usize = PUBKEY_OFFSET + PUBKEY_SIZE;

/// Validate that a specific instruction in the transaction is an Ed25519
/// precompile verification of the expected public key and message.
///
/// The Ed25519 precompile itself verifies the cryptographic signature.
/// This function verifies that the precompile was asked to check the
/// correct inputs (the payer's public key and the binary voucher bytes).
///
/// If this validation is wrong or missing, anyone could submit a settle/close
/// transaction with an Ed25519 instruction that verifies a different key or
/// message, effectively bypassing signature authorization.
pub fn validate_ed25519_instruction(
    instructions_sysvar: &AccountInfo,
    expected_signer: &Pubkey,
    expected_message: &[u8],
    ed25519_instruction_index: u8,
) -> Result<()> {
    // Load the instruction at the given index from the instructions sysvar.
    let instruction = solana_instructions_sysvar::load_instruction_at_checked(
        ed25519_instruction_index as usize,
        instructions_sysvar,
    )
    .map_err(|_| MppChannelError::MissingEd25519Instruction)?;

    // Verify the instruction targets the Ed25519 precompile program.
    if instruction.program_id != solana_sdk_ids::ed25519_program::ID {
        return Err(MppChannelError::InvalidEd25519Program.into());
    }

    let data = &instruction.data;

    // Minimum size: header + descriptor + padding + signature + pubkey + at least 1 byte message
    let min_size = MESSAGE_OFFSET + 1;
    if data.len() < min_size {
        return Err(MppChannelError::MissingEd25519Instruction.into());
    }

    // Verify num_signatures == 1 (we only support single-signature verification).
    let num_signatures = u16::from_le_bytes([data[0], data[1]]);
    if num_signatures != 1 {
        return Err(MppChannelError::MissingEd25519Instruction.into());
    }

    // Extract the public key from the instruction data and compare.
    let pubkey_bytes = &data[PUBKEY_OFFSET..PUBKEY_OFFSET + PUBKEY_SIZE];
    if pubkey_bytes != expected_signer.as_ref() {
        return Err(MppChannelError::InvalidEd25519PublicKey.into());
    }

    // Extract the message from the instruction data and compare.
    let message_bytes = &data[MESSAGE_OFFSET..];
    if message_bytes != expected_message {
        return Err(MppChannelError::InvalidEd25519Message.into());
    }

    Ok(())
}
