/**
 * Payment Link demo module.
 *
 * Demonstrates browser-based payment links: navigate to the endpoint in a
 * browser and you'll see an interactive payment page instead of raw JSON.
 *
 * The `html: true` option on `solana.charge()` makes this seamless —
 * `result.challenge` automatically returns HTML for browsers and JSON for
 * API clients. No manual content negotiation needed.
 */

import type { Express, Request, Response as ExpressResponse } from 'express'
import type { KeyPairSigner } from '@solana/kit'
import { Mppx, solana } from '../sdk.js'
import { toWebRequest, logPayment } from '../utils.js'
import { USDC_MINT, USDC_DECIMALS } from '../constants.js'

const FORTUNES = [
  'A beautiful, smart, and loving person will be coming into your life.',
  'A dubious friend may be an enemy in camouflage.',
  'A faithful friend is a strong defense.',
  'A fresh start will put you on your way.',
  'A golden egg of opportunity falls into your lap this month.',
  'A good time to finish up old tasks.',
  'A light heart carries you through all the hard times.',
  'A smooth long journey! Great expectations.',
  'All your hard work will soon pay off.',
  'An important person will offer you support.',
  'Curiosity kills boredom. Nothing can kill curiosity.',
  'Disbelief destroys the magic.',
  'Every day in your life is a special occasion.',
  'Failure is the chance to do better next time.',
  'Go take a rest; you deserve it.',
  'Good news will come to you by mail.',
  'He who laughs at himself never runs out of things to laugh at.',
  'If you continually give, you will continually have.',
]

export function registerPaymentLink(
  app: Express,
  recipient: string,
  network: string,
  secretKey: string,
  feePayerSigner: KeyPairSigner,
) {
  const rpcUrl = process.env.RPC_URL
  const isMainnet = network === 'mainnet-beta'

  const mppx = Mppx.create({
    secretKey,
    methods: [solana.charge({
      recipient,
      network,
      // Fee payer only on testnet (mainnet needs a funded signer)
      ...(!isMainnet && { signer: feePayerSigner }),
      ...(rpcUrl && { rpcUrl }),
      currency: USDC_MINT,
      decimals: USDC_DECIMALS,
      html: true,
    })],
  })

  app.get('/api/v1/fortune', async (req: Request, res: ExpressResponse) => {
    const result = await mppx.charge({
      amount: '10000', // 0.01 USDC (6 decimals)
      currency: USDC_MINT,
      description: 'Open a fortune cookie',
    })(toWebRequest(req))

    // Forward the response (402 challenge, service worker JS, etc.)
    if (result.status === 402) {
      const challenge = result.challenge as globalThis.Response
      const headers = Object.fromEntries(challenge.headers)
      // Service worker needs this header to register at scope '/'
      if (headers['content-type']?.includes('javascript')) {
        headers['service-worker-allowed'] = '/'
      }
      res.writeHead(challenge.status, headers)
      res.end(await challenge.text())
      return
    }

    // Payment succeeded — return a fortune
    const fortune = FORTUNES[Math.floor(Math.random() * FORTUNES.length)]
    const response = result.withReceipt(
      globalThis.Response.json({ fortune }),
    ) as globalThis.Response
    logPayment(req.path, response)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(await response.text())
  })
}
