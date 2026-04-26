//! SDK-owned placeholder for splits canonicalization.
//!
//! Upstream payment-channels program has not yet defined the
//! canonicalization helpers or the `distribution_hash` algorithm; the product
//! decision on the distribution model (basis-point splits, fixed-amount
//! splits, or a mix) is pending. This module reserves the public names so
//! downstream code can import them stably, and panics via `todo!()` if any
//! caller actually invokes them.
//!
//! TODO: replace each todo!() with a real implementation once the upstream
//! splits design lands. The byte layout and hash algorithm both come from
//! upstream so the SDK side stays a thin wrapper, not a redundant authority.

use solana_pubkey::Pubkey;

/// One basis-point split. The struct shape is carried so downstream wire
/// types (`BpsSplit` <-> `Bps`) and store records compile, even though
/// nothing calls the canonicalization path yet.
#[derive(Clone, Copy, Debug)]
pub struct Bps {
    pub recipient: Pubkey,
    pub share_bps: u16,
}

/// Canonical preimage for a list of splits. Panics via `todo!()` for now
/// so any premature caller fails loudly instead of producing bytes the SDK alone defined.
pub fn canonical_preimage(_splits: &[Bps]) -> Vec<u8> {
    todo!("splits canonical preimage is not implemented: the upstream byte layout has not been finalized, so the SDK has nothing to wrap yet")
}

/// Hash of the canonical preimage, the value stored in
/// `Channel.distribution_hash`. The hash algorithm (sha256 vs blake3) is
/// also pending the upstream decision.
pub fn distribution_hash(_splits: &[Bps]) -> [u8; 32] {
    todo!("distribution_hash is not implemented: the upstream hash algorithm and preimage layout have not been finalized, so the SDK cannot compute a value that would match on-chain verification")
}
