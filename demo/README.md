# Solana MPP Demo

Interactive playground showing the [MPP](https://mpp.dev) payment flow on Solana.
A React frontend calls paid API endpoints; each request triggers an automatic
402 → sign → pay → retry cycle using the `solana-mpp-sdk`.

The server sponsors transaction fees (fee payer mode) so clients only pay the
transfer amount — no SOL needed for gas.

## Prerequisites

- **Node.js** >= 20
- **Surfpool** — local Solana simnet (see below)

### Install Surfpool

```bash
# macOS / Linux
curl -fsSL https://run.surfpool.run | sh
```

> Full instructions: https://docs.surfpool.run/toolchain/getting-started

## Quick Start

```bash
# 1. Start Surfpool (keep this running in its own terminal)
surfpool start

# 2. Install dependencies (from the repo root)
npm run demo:install

# 3. Start the server (new terminal, from the repo root)
npm run demo:server

# 4. Start the frontend (new terminal, from the repo root)
npm run demo:app
```

Open http://localhost:5173 in your browser.

- Charge demo: http://localhost:5173/charges
- Swig session demo: http://localhost:5173/sessions

### Importing a Wallet

In the browser, you can **drag & drop** any Solana keypair JSON file onto the
wallet setup screen to import it (e.g. `~/.config/solana/id.json`), or
generate a fresh one.

## Environment Variables

All optional — the server auto-generates everything it needs at startup.

| Variable        | Default     | Description                                        |
| --------------- | ----------- | -------------------------------------------------- |
| `RECIPIENT`     | (generated) | Solana pubkey that receives payments               |
| `FEE_PAYER_KEY` | (generated) | Base58 keypair for fee sponsorship                 |
| `MPP_SECRET_KEY`| (generated) | HMAC key for signing 402 challenges                |
| `NETWORK`       | `localnet`  | `localnet`, `devnet`, or `mainnet-beta`            |
| `RPC_URL`       | (auto)      | Custom RPC endpoint (defaults to network default)  |
| `PORT`          | `3000`      | Server port                                        |

> On **localnet**, both the recipient and fee payer are auto-generated and funded
> via Surfpool's `surfnet_setAccount` cheatcode. No manual setup needed — just
> start Surfpool and run the demo.

### Running on mainnet

```bash
RECIPIENT=<your-wallet-address> \
NETWORK=mainnet-beta \
RPC_URL=https://mainnet.helius-rpc.com/?api-key=<your-key> \
npm run demo:server
```

On mainnet, fee payer mode is disabled (the generated fee payer has no SOL).
The user's wallet pays transaction fees directly. The payment link page
shows "Continue with Solana" — clicking it connects to Phantom, Solflare,
or any Wallet Standard-compatible wallet.

## API Endpoints

All paid endpoints use **fee payer mode** — the server pays transaction fees
on behalf of clients. Clients only pay the transfer amount.

| Method | Path                              | Cost       |
| ------ | --------------------------------- | ---------- |
| GET    | `/api/v1/stocks/quote/:symbol`    | 0.01 USDC  |
| GET    | `/api/v1/stocks/search?q=`        | 0.01 USDC  |
| GET    | `/api/v1/stocks/history/:symbol`  | 0.05 USDC  |
| GET    | `/api/v1/weather/:city`           | 0.01 USDC  |
| GET    | `/api/v1/fortune`                 | 0.01 USDC (payment link) |
| GET    | `/api/v1/faucet/status`           | Free       |
| POST   | `/api/v1/faucet/airdrop`          | Free       |

The faucet uses Surfpool's `surfnet_setAccount` and `surfnet_setTokenAccount`
cheatcodes to give the client 100 SOL + 100 USDC instantly.

## Swig Session Demo

The Swig demo shows session-based API payments with on-chain role enforcement.

Session endpoints:

| Method | Path                           | Cost                  |
| ------ | ------------------------------ | --------------------- |
| GET    | `/api/v1/swig/research/:topic` | 0.01 USDC / request   |
| GET    | `/api/v1/swig/risk/:symbol`    | 0.01 USDC / request   |
| GET    | `/api/v1/swig/status`          | Free                  |

Flow in the UI:

1. Open `/swig`.
2. Click **Initialize Swig** to create/fetch a Swig wallet role on-chain.
3. Send requests repeatedly to watch session open/update events.
4. Use **Close Session** to submit a close action and settle USDC on-chain.

The client uses `SwigSessionAuthorizer` and creates delegated session keys on-chain.
The server only accepts `swig_session` mode for these endpoints and verifies close-settlement transactions.

## How It Works

1. Client sends a request to a paid endpoint
2. Server returns **402 Payment Required** with a challenge (includes `feePayerKey`)
3. Client builds a transaction with the server's key as fee payer, partially signs
   it (transfer authority only), and sends the signed bytes back
4. Server co-signs as fee payer, broadcasts to Solana, confirms on-chain,
   and verifies the transfer
5. Server returns the API response with a `Payment-Receipt` header

The entire flow is handled transparently by `mppx.fetch()` on the client side.
The client never pays transaction fees — only the exact transfer amount.

## Running Tests

From the repo root:

```bash
# Unit tests (no network needed)
npm test

# Integration tests (requires Surfpool on localhost:8899)
npm run test:integration

# Both
npm run test:all
```

## Project Structure

```
demo/
├── app/                        React/Vite frontend
│   └── src/
│       ├── App.tsx             Routes + API playground
│       ├── Landing.tsx         Landing page
│       ├── wallet.ts           Keypair management, mppx client
│       ├── endpoints.ts        Endpoint definitions + code snippets
│       └── components/
│           ├── WalletSetup.tsx  Generate / import / drag-drop keypair
│           ├── WalletModal.tsx  Balance + address display
│           └── CodeBlock.tsx    Syntax-highlighted code viewer
│
└── server/                     Express backend
    ├── index.ts                Entry point + fee payer setup
    ├── sdk.ts                  SDK re-exports
    ├── utils.ts                Express → Web Request adapter
    └── modules/
        ├── stocks.ts           Yahoo Finance (paid, server pays fees)
        ├── weather.ts          City weather (paid, server pays fees)
        └── faucet.ts           100 SOL + 100 USDC via surfpool cheatcodes
```
