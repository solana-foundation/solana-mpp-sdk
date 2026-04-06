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

# ── HTML Payment Links ──

# Install HTML payment link dependencies
html-install:
    cd html && npm install

# Build HTML payment link assets (bundles JS for all server implementations)
html-build:
    cd html && npm run build

# Build HTML assets in test mode (with sourcemaps)
html-build-test:
    cd html && npm run build:test

# Run payment link E2E tests (requires Surfpool on :8899 and demo server on :3000)
html-test-e2e:
    cd html && npm run test:e2e

# ── Orchestration ──

# Build compiled SDKs
build: html-build ts-build rs-build

# Run all unit tests
test: ts-test rs-test go-test lua-test

# Run all tests including integration + coverage gates
test-all: ts-test ts-test-integration rs-test

# Format everything
fmt: ts-fmt rs-fmt

# Pre-commit checks
pre-commit: ts-audit ts-fmt ts-typecheck ts-test rs-fmt rs-lint rs-test
