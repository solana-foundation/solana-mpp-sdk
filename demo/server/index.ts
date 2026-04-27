import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Request, Response } from 'express'
import {
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase58Encoder,
  type KeyPairSigner,
} from '@solana/kit'
import { registerStocks } from './modules/stocks.js'
import { registerWeather } from './modules/weather.js'
import { registerFaucet } from './modules/faucet.js'
import { registerMarketplace } from './modules/marketplace.js'
import { registerPaymentLink } from './modules/paymentlink.js'

// Recipient is the address that receives payments.
// If not provided, generate one automatically (demo convenience).
let RECIPIENT = process.env.RECIPIENT
if (!RECIPIENT) {
  const recipientSigner = await generateKeyPairSigner()
  RECIPIENT = recipientSigner.address
}

const NETWORK = (process.env.NETWORK ?? 'localnet') as string
const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8899'
const SECRET_KEY = process.env.MPP_SECRET_KEY ?? crypto.randomBytes(32).toString('hex')

// ── Fee payer signer ──
// The server pays transaction fees on behalf of clients.
// Uses FEE_PAYER_KEY env var (base58 keypair) or generates a fresh one.

let feePayerSigner: KeyPairSigner

if (process.env.FEE_PAYER_KEY) {
  const bytes = getBase58Encoder().encode(process.env.FEE_PAYER_KEY)
  feePayerSigner = await createKeyPairSignerFromBytes(bytes)
} else {
  feePayerSigner = await generateKeyPairSigner()
}

// Fund fee payer via surfpool cheatcode (set SOL balance directly)
try {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'surfnet_setAccount',
      params: [
        feePayerSigner.address,
        {
          lamports: 100_000_000_000, // 100 SOL
          data: '',
          executable: false,
          owner: '11111111111111111111111111111111',
          rentEpoch: 0,
        },
      ],
    }),
  })
  const data = (await res.json()) as { error?: any }
  if (data.error) {
    console.warn('Could not fund fee payer via surfpool:', data.error)
  }
} catch {
  console.warn('Surfpool not reachable — fee payer may not have SOL for fees.')
}

// ── Express app ──

const app = express()
app.use(express.json())
app.use(
  cors({
    exposedHeaders: [
      'www-authenticate',
      'payment-receipt',
    ],
  }),
)

// Health check — also exposes fee payer balance for the UI
app.get('/api/v1/health', async (_req: Request, res: Response) => {
  let feePayerBalance: number | undefined
  try {
    const rpc = createSolanaRpc(RPC_URL)
    const { value } = await rpc.getBalance(feePayerSigner.address).send()
    feePayerBalance = Number(value) / 1e9
  } catch { /* surfpool may be down */ }
  res.json({
    ok: true,
    feePayer: feePayerSigner.address,
    feePayerBalance,
  })
})

// Register modules
registerStocks(app, RECIPIENT, NETWORK, SECRET_KEY, feePayerSigner)
registerWeather(app, RECIPIENT, NETWORK, SECRET_KEY, feePayerSigner)
registerFaucet(app, NETWORK)
registerMarketplace(app, RECIPIENT, NETWORK, SECRET_KEY, feePayerSigner)
registerPaymentLink(app, RECIPIENT, NETWORK, SECRET_KEY, feePayerSigner)

// Serve SPA in production
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDist = path.join(__dirname, '../app/dist')
app.use(express.static(appDist))
app.get('*splat', (_req: Request, res: Response) => {
  res.sendFile(path.join(appDist, 'index.html'))
})

// ANSI colors
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => {
  console.log()
  console.log(bold('  solana-mpp demo'))
  console.log()
  console.log(`  ${dim('Server')}      ${cyan(`http://localhost:${PORT}`)}`)
  console.log(`  ${dim('Recipient')}   ${green(RECIPIENT)}`)
  console.log(`  ${dim('Fee payer')}   ${green(feePayerSigner.address)}`)
  console.log(`  ${dim('Network')}     ${magenta(NETWORK)}`)
  console.log()
  console.log(bold('  Endpoints'))
  console.log()
  const endpoints = [
    { method: 'GET',  path: '/api/v1/stocks/quote/:symbol',  cost: '0.01 USDC' },
    { method: 'GET',  path: '/api/v1/stocks/search?q=',      cost: '0.01 USDC' },
    { method: 'GET',  path: '/api/v1/stocks/history/:symbol', cost: '0.05 USDC' },
    { method: 'GET',  path: '/api/v1/weather/:city',          cost: '0.01 USDC' },
    { method: 'GET',  path: '/api/v1/marketplace/products',    cost: '' },
    { method: 'GET',  path: '/api/v1/marketplace/buy/:id',    cost: 'varies (splits: seller + platform 5% + referral 2%)' },
    { method: 'POST', path: '/api/v1/faucet/airdrop',         cost: '' },
    { method: 'GET',  path: '/api/v1/faucet/status',           cost: '' },
    { method: 'GET',  path: '/api/v1/fortune',                 cost: '0.01 USDC (payment link!)' },
  ]
  const maxMethod = Math.max(...endpoints.map(e => e.method.length))
  const maxPath = Math.max(...endpoints.map(e => e.path.length))
  for (const ep of endpoints) {
    const m = ep.method === 'POST' ? cyan(ep.method) : green(ep.method)
    const mPad = ' '.repeat(maxMethod - ep.method.length)
    const pPad = ' '.repeat(maxPath - ep.path.length)
    const cost = ep.cost ? `${yellow(ep.cost)}  ${dim('server pays fees')}` : dim('free')
    console.log(`  ${m}${mPad}  ${ep.path}${pPad}  ${cost}`)
  }
  console.log()
})
