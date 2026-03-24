set shell := ["bash", "-uc"]

default:
    @just --list

# ── TypeScript ──

# Install TypeScript dependencies
ts-install:
    cd typescript && pnpm install

# Build TypeScript packages
ts-build:
    cd typescript && pnpm build

# Typecheck TypeScript
ts-typecheck:
    cd typescript && pnpm typecheck

# Unit tests (TypeScript)
ts-test:
    cd typescript && pnpm test

# Integration tests (TypeScript, requires Surfpool)
ts-test-integration:
    cd typescript && pnpm test:integration

# Format and lint TypeScript
ts-fmt:
    cd typescript && pnpm lint:fix && pnpm format

# Audit TypeScript dependencies
ts-audit:
    cd typescript && pnpm audit --production

# ── Rust ──

# Build Rust crate
rs-build:
    cd rust && cargo build

# Test Rust crate
rs-test:
    cd rust && cargo test

# Format Rust
rs-fmt:
    cd rust && cargo fmt

# Lint Rust
rs-lint:
    cd rust && cargo clippy -- -D warnings

# ── Anchor ──

# Build Anchor program (programs/mpp-channel)
anchor-build:
    anchor build --no-idl

# Run Anchor localnet tests (starts solana-test-validator automatically)
anchor-test:
    anchor test

# ── Orchestration ──

# Build everything
build: ts-build rs-build anchor-build

# Run all unit tests
test: ts-test rs-test

# Run all tests including integration
test-all: ts-test ts-test-integration rs-test anchor-test

# Format everything
fmt: ts-fmt rs-fmt

# Pre-commit checks
pre-commit: ts-audit ts-fmt ts-typecheck ts-test rs-fmt rs-lint rs-test
