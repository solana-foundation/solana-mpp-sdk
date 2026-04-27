//! Program boundary for `Moonsong-Labs/solana-payment-channels`.
//!
//! Everything that touches program bytes lives here. The SDK owns the three
//! byte contracts (voucher signed payload, ed25519 precompile ix, Channel
//! PDA) as hand-written modules; the program
//! source is read-only reference documentation, never vendored. The Codama-
//! generated client is the external `payment_channels_client` crate (pinned
//! by rev in `Cargo.toml`); import directly from
//! `payment_channels_client::{accounts, instructions, programs, types}`
//! anywhere in the SDK. No wrapper module, no re-exports at this layer.
//!
//! Downstream modules (server, client, protocol) consume this module's typed
//! Rust values and never reach into the program boundary layout directly.

// SDK-owned byte-contract implementations.
pub mod voucher;  // Contract 1: 48-byte signed payload + Contract 2 composer (build_verify_ix)
pub mod state;    // Contract 3: Channel PDA derivation + typed ChannelView

// SDK-owned orchestration and RPC helpers.
pub mod ix;
pub mod verify;

// Placeholder until the upstream splits-canonicalization design lands.
pub mod splits_ext;
