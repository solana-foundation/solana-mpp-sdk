//! L0 PDA derivation parity.
//!
//! The SDK must derive the Channel PDA with the exact seed order the on-chain
//! program uses; otherwise `open` creates an account the program cannot
//! rediscover, and subsequent calls fail with a seeds mismatch. These tests
//! pin the derivation against determinism, salt sensitivity, authorized-signer
//! sensitivity, and canonical-bump invariance.

use solana_mpp::program::payment_channels::state::find_channel_pda;
use solana_pubkey::Pubkey;

#[test]
fn pda_stable_across_calls() {
    let payer = Pubkey::new_from_array([1u8; 32]);
    let payee = Pubkey::new_from_array([2u8; 32]);
    let mint = Pubkey::new_from_array([3u8; 32]);
    let signer = Pubkey::new_from_array([4u8; 32]);
    let program_id = Pubkey::new_from_array([5u8; 32]);

    let (pda_a, bump_a) = find_channel_pda(&payer, &payee, &mint, &signer, 42, &program_id);
    let (pda_b, bump_b) = find_channel_pda(&payer, &payee, &mint, &signer, 42, &program_id);
    assert_eq!(pda_a, pda_b);
    assert_eq!(bump_a, bump_b);
}

#[test]
fn pda_differs_on_salt_change() {
    let payer = Pubkey::new_from_array([1u8; 32]);
    let payee = Pubkey::new_from_array([2u8; 32]);
    let mint = Pubkey::new_from_array([3u8; 32]);
    let signer = Pubkey::new_from_array([4u8; 32]);
    let program_id = Pubkey::new_from_array([5u8; 32]);

    let (pda_a, _) = find_channel_pda(&payer, &payee, &mint, &signer, 1, &program_id);
    let (pda_b, _) = find_channel_pda(&payer, &payee, &mint, &signer, 2, &program_id);
    assert_ne!(pda_a, pda_b);
}

#[test]
fn pda_differs_on_authorized_signer_change() {
    let payer = Pubkey::new_from_array([1u8; 32]);
    let payee = Pubkey::new_from_array([2u8; 32]);
    let mint = Pubkey::new_from_array([3u8; 32]);
    let s1 = Pubkey::new_from_array([4u8; 32]);
    let s2 = Pubkey::new_from_array([5u8; 32]);
    let program_id = Pubkey::new_from_array([6u8; 32]);

    let (pda_a, _) = find_channel_pda(&payer, &payee, &mint, &s1, 1, &program_id);
    let (pda_b, _) = find_channel_pda(&payer, &payee, &mint, &s2, 1, &program_id);
    assert_ne!(pda_a, pda_b);
}

#[test]
fn pda_bump_matches_program_derivation() {
    // "Canonical bump" means: re-deriving the PDA via `create_program_address`
    // with the bump from `find_program_address` produces the same address. This
    // is the definition the on-chain program uses when it verifies the PDA, so
    // a mismatch here means `open` will fail on-chain with a seeds mismatch.
    use solana_mpp::program::payment_channels::state::channel_seeds;

    let payer = Pubkey::new_unique();
    let payee = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let signer = Pubkey::new_unique();
    let program_id = Pubkey::new_unique();

    let (pda, bump) = find_channel_pda(&payer, &payee, &mint, &signer, 0, &program_id);

    let salt_le = 0u64.to_le_bytes();
    let seeds = channel_seeds(&payer, &payee, &mint, &signer, &salt_le);
    let bump_bytes = [bump];
    let seeds_with_bump: Vec<&[u8]> = seeds
        .iter()
        .copied()
        .chain(std::iter::once(bump_bytes.as_slice()))
        .collect();

    let re_derived = Pubkey::create_program_address(&seeds_with_bump, &program_id)
        .expect("canonical bump must produce a valid PDA");

    assert_eq!(
        re_derived, pda,
        "find_program_address bump is not canonical: create_program_address diverged"
    );
}
