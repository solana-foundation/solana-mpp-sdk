import {
  createKeyPairSignerFromBytes,
  getBase58Encoder,
  getBase58Decoder,
  createSolanaRpc,
  address,
  type KeyPairSigner,
} from '@solana/kit'
import { findAssociatedTokenPda } from '@solana-program/token'
import { Mppx, solana } from '@solana/mpp/client'

const STORAGE_KEY = 'solana-mpp-demo:secret-key'
const RPC_URL = 'http://localhost:8899'

// ── Key management ──

export function loadSecretKey(): string | null {
  return localStorage.getItem(STORAGE_KEY)
}

export function saveSecretKey(base58Key: string) {
  localStorage.setItem(STORAGE_KEY, base58Key)
}

export function clearWallet() {
  localStorage.removeItem(STORAGE_KEY)
  signerPromise = null
  mppxInstance = null
}

// ── Signer singleton ──

let signerPromise: Promise<KeyPairSigner> | null = null

export async function getSigner(): Promise<KeyPairSigner> {
  if (!signerPromise) {
    const key = loadSecretKey()
    if (!key) throw new Error('No wallet configured')
    signerPromise = createKeyPairSignerFromBytes(getBase58Encoder().encode(key))
  }
  return signerPromise
}

/** Generate a fresh keypair using WebCrypto Ed25519. */
export async function generateWallet(): Promise<KeyPairSigner> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
    true,
    ['sign', 'verify'],
  )

  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  // PKCS8 for Ed25519 has the 32-byte private key at offset 16
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey))
  const privateKey = pkcs8.slice(16, 48)
  const combined = new Uint8Array(64)
  combined.set(privateKey)
  combined.set(publicKey, 32)

  const base58Key = getBase58Decoder().decode(combined)
  saveSecretKey(base58Key)
  signerPromise = null
  return getSigner()
}

/** Import a Solana CLI keypair JSON file (64-byte array). */
export async function importKeypairJson(jsonContent: string): Promise<KeyPairSigner> {
  const bytes = JSON.parse(jsonContent) as number[]
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error('Invalid keypair file: expected a JSON array of 64 bytes')
  }
  const combined = new Uint8Array(bytes)
  const base58Key = getBase58Decoder().decode(combined)
  saveSecretKey(base58Key)
  signerPromise = null
  return getSigner()
}

// ── Balance ──

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export type Balances = { sol: number; usdc: number }

export async function getBalances(): Promise<Balances> {
  const signer = await getSigner()
  const rpc = createSolanaRpc(RPC_URL)

  // SOL balance
  const { value: lamports } = await rpc.getBalance(signer.address).send()
  const sol = Number(lamports) / 1e9

  // USDC balance — derive ATA and fetch directly (avoids getTokenAccountsByOwner
  // which can trigger surfpool to proxy to mainnet and get rate-limited).
  let usdc = 0
  try {
    const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
    const [ata] = await findAssociatedTokenPda({
      owner: signer.address,
      mint: address(USDC_MINT),
      tokenProgram: address(TOKEN_PROGRAM),
    })
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [ata, { encoding: 'jsonParsed' }],
      }),
    })
    const data = (await res.json()) as any
    const amount = data?.result?.value?.data?.parsed?.info?.tokenAmount?.uiAmount
    if (typeof amount === 'number') usdc = amount
  } catch {
    // token account may not exist yet
  }

  return { sol, usdc }
}

export async function getSolBalance(address: string): Promise<number> {
  const rpc = createSolanaRpc(RPC_URL)
  const { value } = await rpc.getBalance(address as any).send()
  return Number(value) / 1e9
}

// ── Airdrop ──

export async function requestAirdrop(): Promise<void> {
  const signer = await getSigner()
  const res = await fetch('/api/v1/faucet/airdrop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: signer.address }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Airdrop failed')
}

// ── Mppx client singleton ──

let mppxInstance: ReturnType<typeof Mppx.create> | null = null

async function getMppx() {
  if (!mppxInstance) {
    const signer = await getSigner()
    const method = solana.charge({
      signer,
      rpcUrl: RPC_URL,
      onProgress(event: ProgressEvent) {
        progressCallback?.(event)
      },
    })
    mppxInstance = Mppx.create({ methods: [method] })
  }
  return mppxInstance
}

type ProgressEvent =
  | { type: 'challenge'; recipient: string; amount: string; currency: string; spl?: string; feePayerKey?: string }
  | { type: 'signing' }
  | { type: 'signed'; transaction: string }
  | { type: 'paying' }
  | { type: 'confirming'; signature: string }
  | { type: 'paid'; signature: string }

let progressCallback: ((event: ProgressEvent) => void) | null = null

// ── Pay and fetch ──

export type Step =
  | { type: 'request'; url: string }
  | { type: 'challenge'; amount: string; recipient: string; currency?: string; feePayerKey?: string }
  | { type: 'signing' }
  | { type: 'paying' }
  | { type: 'confirming'; signature: string }
  | { type: 'paid'; signature: string }
  | { type: 'success'; data: unknown; status: number }
  | { type: 'error'; message: string }

export async function* payAndFetch(url: string): AsyncGenerator<Step> {
  yield { type: 'request', url }

  const steps: Step[] = []
  let resolve: (() => void) | null = null

  progressCallback = (event) => {
    let step: Step
    switch (event.type) {
      case 'challenge':
        step = { type: 'challenge', amount: event.amount, recipient: event.recipient, currency: event.currency, feePayerKey: event.feePayerKey }
        break
      case 'signing':
        step = { type: 'signing' }
        break
      case 'signed':
        return // internal detail, skip
      case 'paying':
        step = { type: 'paying' }
        break
      case 'confirming':
        step = { type: 'confirming', signature: event.signature }
        break
      case 'paid':
        step = { type: 'paid', signature: event.signature }
        break
    }
    steps.push(step)
    resolve?.()
  }

  try {
    const mppx = await getMppx()
    const fetchPromise = mppx.fetch(url)

    // Yield progress steps as they arrive, then yield the final result.
    while (true) {
      if (steps.length > 0) {
        yield steps.shift()!
        continue
      }

      // Race: either new progress arrives or fetch completes.
      const result = await Promise.race([
        fetchPromise.then((r: Response) => ({ done: true as const, response: r })),
        new Promise<{ done: false }>((r) => {
          resolve = () => r({ done: false })
        }),
      ])

      if (result.done) {
        // Drain remaining steps
        while (steps.length > 0) yield steps.shift()!

        const response = result.response
        try {
          const data = await response.json()
          yield { type: 'success', data, status: response.status }
        } catch {
          yield { type: 'success', data: await response.text(), status: response.status }
        }
        return
      }
    }
  } catch (err: any) {
    yield { type: 'error', message: err?.message ?? String(err) }
  } finally {
    progressCallback = null
  }
}
