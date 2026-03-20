import type { Express } from 'express'
import type { KeyPairSigner } from '@solana/kit'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
import { Mppx, solana } from '../sdk.js'
import { toWebRequest, logPayment } from '../utils.js'
import { USDC_MINT } from '../constants.js'

export function registerStocks(
  app: Express,
  recipient: string,
  network: string,
  secretKey: string,
  feePayerSigner: KeyPairSigner,
) {
  const mppx = Mppx.create({
    secretKey,
    methods: [solana.charge({
      recipient,
      network,
      signer: feePayerSigner,
      spl: USDC_MINT,
      decimals: 6,
    })],
  })

  // Quote
  app.get('/api/v1/stocks/quote/:symbol', async (req, res) => {
    const result = await mppx.charge({
      amount: '10000', // 0.01 USDC
      currency: 'USDC',
      description: `Stock quote: ${req.params.symbol}`,
    })(toWebRequest(req))

    if (result.status === 402) {
      const challenge = result.challenge as Response
      res.writeHead(challenge.status, Object.fromEntries(challenge.headers))
      res.end(await challenge.text())
      return
    }

    try {
      const quote = await yahooFinance.quote(req.params.symbol)
      const response = result.withReceipt(Response.json(quote)) as Response
      logPayment(req.path, response)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(await response.text())
    } catch (err) {
      console.error('stocks/quote error:', err)
      res.status(500).json({ error: 'Failed to fetch quote' })
    }
  })

  // Search
  app.get('/api/v1/stocks/search', async (req, res) => {
    const q = req.query.q as string
    if (!q) return res.status(400).json({ error: 'Missing ?q= parameter' })

    const result = await mppx.charge({
      amount: '10000', // 0.01 USDC
      currency: 'USDC',
      description: `Stock search: ${q}`,
    })(toWebRequest(req))

    if (result.status === 402) {
      const challenge = result.challenge as Response
      res.writeHead(challenge.status, Object.fromEntries(challenge.headers))
      res.end(await challenge.text())
      return
    }

    try {
      const { quotes } = await yahooFinance.search(q)
      const response = result.withReceipt(Response.json(quotes)) as Response
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(await response.text())
    } catch (err) {
      console.error('stocks/search error:', err)
      res.status(500).json({ error: 'Failed to search' })
    }
  })

  // History
  app.get('/api/v1/stocks/history/:symbol', async (req, res) => {
    const result = await mppx.charge({
      amount: '50000', // 0.05 USDC
      currency: 'USDC',
      description: `Stock history: ${req.params.symbol}`,
    })(toWebRequest(req))

    if (result.status === 402) {
      const challenge = result.challenge as Response
      res.writeHead(challenge.status, Object.fromEntries(challenge.headers))
      res.end(await challenge.text())
      return
    }

    try {
      const range = (req.query.range as string) || '1mo'
      const rangeToDate: Record<string, number> = {
        '1d': 1, '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365,
      }
      const days = rangeToDate[range] ?? 30
      const period1 = new Date(Date.now() - days * 86400_000)
      const chart = await yahooFinance.chart(req.params.symbol, { period1 })
      const response = result.withReceipt(Response.json(chart)) as Response
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(await response.text())
    } catch (err) {
      console.error('stocks/history error:', err)
      res.status(500).json({ error: 'Failed to fetch history' })
    }
  })
}
