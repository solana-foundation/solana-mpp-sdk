import { Method, Receipt, Store } from 'mppx'
import { findAssociatedTokenPda } from '@solana-program/token'
import {
  address,
  getTransactionDecoder,
  partiallySignTransaction,
  getBase64EncodedWireTransaction,
  isKeyPairSigner,
  type TransactionSigner,
} from '@solana/kit'
import * as Methods from '../Methods.js'
import {
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  DEFAULT_RPC_URLS,
} from '../constants.js'

/**
 * Creates a Solana `charge` method for usage on the server.
 *
 * Supports two credential types:
 *
 * - **type="transaction"** (default): The server receives a signed transaction
 *   from the client, broadcasts it to Solana, confirms it, and verifies the
 *   transfer on-chain. When `signer` is provided, the server co-signs as fee
 *   payer before broadcasting.
 *
 * - **type="signature"**: The client has already broadcast and confirmed the
 *   transaction. The server verifies the transfer on-chain using the signature.
 *
 * @example
 * ```ts
 * import { Mppx, solana } from 'solana-mpp-sdk/server'
 *
 * const mppx = Mppx.create({
 *   methods: [solana.charge({
 *     recipient: 'RecipientPubkey...',
 *     splToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
 *     decimals: 6,
 *     network: 'devnet',
 *   })],
 * })
 *
 * export async function handler(request: Request) {
 *   const result = await mppx.charge({ amount: '1000000', currency: 'USDC' })(request)
 *   if (result.status === 402) return result.challenge
 *   return result.withReceipt(Response.json({ data: '...' }))
 * }
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const {
    recipient,
    splToken,
    decimals,
    tokenProgram = TOKEN_PROGRAM,
    network = 'mainnet-beta',
    store = Store.memory(),
    signer,
  } = parameters

  const rpcUrl =
    parameters.rpcUrl ??
    DEFAULT_RPC_URLS[network] ??
    DEFAULT_RPC_URLS['mainnet-beta']

  if (splToken && decimals === undefined) {
    throw new Error('decimals is required when splToken is set')
  }

  if (signer && !isKeyPairSigner(signer)) {
    throw new Error(
      'signer must be a KeyPairSigner (created via generateKeyPairSigner or createKeyPairSignerFromBytes) for fee payer mode',
    )
  }

  return Method.toServer(Methods.charge, {
    defaults: {
      currency: splToken ? 'token' : 'SOL',
      recipient: '',
      methodDetails: {
        reference: '',
      },
    },

    async request({ credential, request }) {
      if (credential) {
        return credential.challenge.request as typeof request
      }

      const reference = crypto.randomUUID()

      return {
        ...request,
        recipient,
        methodDetails: {
          reference,
          network,
          ...(splToken
            ? { splToken, decimals, tokenProgram }
            : {}),
          ...(signer
            ? { feePayer: true, feePayerKey: signer.address }
            : {}),
        },
      }
    },

    async verify({ credential }) {
      const cred = credential as unknown as CredentialPayload
      const challenge = cred.challenge.request
      const payloadType = resolvePayloadType(cred.payload)

      // Spec: type="signature" MUST NOT be used with feePayer: true
      if (payloadType === 'signature' && challenge.methodDetails.feePayer) {
        throw new Error(
          'type="signature" credentials cannot be used with fee sponsorship (feePayer: true)',
        )
      }

      if (payloadType === 'transaction') {
        return await verifyTransaction(
          cred,
          challenge,
          rpcUrl,
          recipient,
          store,
          signer,
        )
      }

      return await verifySignature(
        cred,
        challenge,
        rpcUrl,
        recipient,
        store,
      )
    },
  })
}

// ── Payload type resolution ──

function resolvePayloadType(
  payload: { type?: string; signature?: string; transaction?: string },
): 'transaction' | 'signature' {
  if (payload.type === 'signature') return 'signature'
  if (payload.type === 'transaction') return 'transaction'
  throw new Error('Missing or invalid payload type: must be "transaction" or "signature"')
}

// ── Server-broadcast path (type="transaction") ──

async function verifyTransaction(
  credential: CredentialPayload,
  challenge: ChallengeRequest,
  rpcUrl: string,
  recipient: string,
  store: Store.Store,
  signer?: TransactionSigner,
) {
  const { transaction: clientTxBase64 } = credential.payload
  if (!clientTxBase64) {
    throw new Error('Missing transaction data in credential payload')
  }

  let txToSend = clientTxBase64

  // When the server has a fee payer signer, decode the client's partially-signed
  // transaction, add the fee payer signature, and re-encode.
  if (signer && isKeyPairSigner(signer)) {
    const txBytes = Uint8Array.from(atob(clientTxBase64), (c) => c.charCodeAt(0))
    const decoder = getTransactionDecoder()
    const tx = decoder.decode(txBytes)
    const cosigned = await partiallySignTransaction([signer.keyPair], tx)
    txToSend = getBase64EncodedWireTransaction(cosigned)
  }

  // Broadcast the (now fully-signed) transaction.
  const signature = await broadcastTransaction(rpcUrl, txToSend)

  // Wait for on-chain confirmation.
  await waitForConfirmation(rpcUrl, signature)

  // Verify the confirmed transaction matches the challenge.
  await verifyOnChain(rpcUrl, signature, challenge, recipient)

  // Mark consumed to prevent replay.
  await store.put(`solana-charge:consumed:${signature}`, true)

  return Receipt.from({
    method: 'solana',
    reference: signature,
    status: 'success',
    timestamp: new Date().toISOString(),
  })
}

// ── Client-broadcast path (type="signature") ──

async function verifySignature(
  credential: CredentialPayload,
  challenge: ChallengeRequest,
  rpcUrl: string,
  recipient: string,
  store: Store.Store,
) {
  const { signature } = credential.payload
  if (!signature) {
    throw new Error('Missing signature in credential payload')
  }

  // Replay prevention: reject already-consumed transaction signatures.
  const consumedKey = `solana-charge:consumed:${signature}`
  if (await store.get(consumedKey)) {
    throw new Error('Transaction signature already consumed')
  }

  // Fetch and verify the transaction on-chain.
  const tx = await fetchTransaction(rpcUrl, signature)
  if (!tx) throw new Error('Transaction not found or not yet confirmed')
  if (tx.meta?.err) throw new Error('Transaction failed on-chain')

  const instructions = tx.transaction.message.instructions
  await verifyInstructions(instructions, challenge, recipient)

  // Mark consumed to prevent replay.
  await store.put(consumedKey, true)

  return Receipt.from({
    method: 'solana',
    reference: signature,
    status: 'success',
    timestamp: new Date().toISOString(),
  })
}

// ── Shared on-chain verification ──

async function verifyOnChain(
  rpcUrl: string,
  signature: string,
  challenge: ChallengeRequest,
  recipient: string,
) {
  const tx = await fetchTransaction(rpcUrl, signature)
  if (!tx) throw new Error('Transaction not found or not yet confirmed')
  if (tx.meta?.err) throw new Error('Transaction failed on-chain')

  const instructions = tx.transaction.message.instructions
  await verifyInstructions(instructions, challenge, recipient)
}

async function verifyInstructions(
  instructions: ParsedInstruction[],
  challenge: ChallengeRequest,
  recipient: string,
) {
  const expectedAmount = challenge.amount

  if (challenge.methodDetails.splToken) {
    // ── SPL token transfer verification ──
    const transfer = instructions.find(
      (ix) =>
        ix.parsed?.type === 'transferChecked' &&
        (ix.programId === TOKEN_PROGRAM ||
          ix.programId === TOKEN_2022_PROGRAM),
    )
    if (!transfer) {
      throw new Error('No TransferChecked instruction found in transaction')
    }

    const info = transfer.parsed!.info as {
      mint: string
      destination: string
      tokenAmount: { amount: string }
    }
    if (info.mint !== challenge.methodDetails.splToken) {
      throw new Error(
        `Token mint mismatch: expected ${challenge.methodDetails.splToken}, got ${info.mint}`,
      )
    }
    if (info.tokenAmount.amount !== expectedAmount) {
      throw new Error(
        `Amount mismatch: expected ${expectedAmount}, got ${info.tokenAmount.amount}`,
      )
    }

    // Verify destination ATA belongs to the expected recipient.
    const expectedTokenProgram =
      challenge.methodDetails.tokenProgram || TOKEN_PROGRAM
    const [expectedAta] = await findAssociatedTokenPda({
      owner: address(recipient),
      mint: address(challenge.methodDetails.splToken),
      tokenProgram: address(expectedTokenProgram),
    })
    if (info.destination !== expectedAta) {
      throw new Error(
        'Destination token account does not belong to expected recipient',
      )
    }
  } else {
    // ── Native SOL transfer verification ──
    const transfer = instructions.find(
      (ix) =>
        ix.parsed?.type === 'transfer' && ix.program === 'system',
    )
    if (!transfer) {
      throw new Error('No system transfer instruction found in transaction')
    }

    const info = transfer.parsed!.info as {
      destination: string
      lamports: number
    }
    if (info.destination !== recipient) {
      throw new Error(
        `Recipient mismatch: expected ${recipient}, got ${info.destination}`,
      )
    }
    if (String(info.lamports) !== expectedAmount) {
      throw new Error(
        `Amount mismatch: expected ${expectedAmount} lamports, got ${info.lamports}`,
      )
    }
  }
}

// ── Types ──

/** Credential payload from the mppx framework. */
type CredentialPayload = {
  payload: {
    type?: string
    signature?: string
    transaction?: string
  }
  challenge: {
    id?: string
    request: ChallengeRequest
  }
}

/** The request portion of a challenge, matching the Methods.ts schema. */
type ChallengeRequest = {
  amount: string
  currency: string
  recipient: string
  methodDetails: {
    reference: string
    network?: string
    splToken?: string
    decimals?: number
    tokenProgram?: string
    feePayer?: boolean
    feePayerKey?: string
  }
}

/** A parsed instruction from a jsonParsed transaction. */
type ParsedInstruction = {
  program?: string
  programId?: string
  parsed?: {
    type: string
    info: Record<string, unknown>
  }
}

/** A parsed transaction result from getTransaction RPC. */
type ParsedTransaction = {
  meta: { err: unknown } | null
  transaction: {
    message: {
      instructions: ParsedInstruction[]
    }
  }
}

// ── RPC helpers ──

async function fetchTransaction(
  rpcUrl: string,
  signature: string,
): Promise<ParsedTransaction | null> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        signature,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  })
  const data = (await response.json()) as {
    result?: ParsedTransaction | null
    error?: { message: string }
  }
  if (data.error) throw new Error(`RPC error: ${data.error.message}`)
  return data.result ?? null
}

async function broadcastTransaction(
  rpcUrl: string,
  base64Tx: string,
): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [base64Tx, { encoding: 'base64', skipPreflight: false }],
    }),
  })
  const data = (await response.json()) as {
    result?: string
    error?: { message: string }
  }
  if (data.error) throw new Error(`RPC error: ${data.error.message}`)
  if (!data.result) throw new Error('No signature returned from sendTransaction')
  return data.result
}

async function waitForConfirmation(
  rpcUrl: string,
  signature: string,
  timeoutMs = 30_000,
) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignatureStatuses',
        params: [[signature]],
      }),
    })
    const data = (await response.json()) as { result?: { value: any[] } }
    const status = data.result?.value?.[0]
    if (status) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`)
      }
      if (
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized'
      ) {
        return
      }
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error('Transaction confirmation timeout')
}

export declare namespace charge {
  type Parameters = {
    /** Base58-encoded recipient public key that receives payments. */
    recipient: string
    /** SPL token mint address. If absent, payments are in native SOL. */
    splToken?: string
    /** Token decimals (required when splToken is set). */
    decimals?: number
    /** Token program address. Defaults to TOKEN_PROGRAM. Set to TOKEN_2022_PROGRAM for Token-2022 mints. */
    tokenProgram?: string
    /** Solana network. Defaults to 'mainnet-beta'. */
    network?: 'mainnet-beta' | 'devnet' | 'localnet' | (string & {})
    /** Custom RPC URL. Defaults to public RPC for the selected network. */
    rpcUrl?: string
    /**
     * Pluggable key-value store for consumed-signature tracking (replay prevention).
     * Defaults to in-memory. Use a persistent store in production.
     */
    store?: Store.Store
    /**
     * Server-side KeyPairSigner for fee sponsorship (feePayer mode).
     * When provided, the server's public key is included in the challenge
     * as `feePayerKey`, and the server co-signs the transaction as fee payer
     * before broadcasting.
     *
     * Must be a KeyPairSigner (from `generateKeyPairSigner` or
     * `createKeyPairSignerFromBytes`).
     */
    signer?: TransactionSigner
  }
}
