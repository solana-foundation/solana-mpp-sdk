import type { Express } from 'express'
import type { KeyPairSigner } from '@solana/kit'
import { Mppx, solana } from '../sdk.js'
import { toWebRequest, logPayment } from '../utils.js'
import { USDC_MINT } from '../constants.js'

// Simple in-memory weather data for the demo (no external API needed).
const WEATHER: Record<string, { temperature: number; conditions: string; humidity: number }> = {
  'san-francisco': { temperature: 15, conditions: 'Foggy', humidity: 85 },
  'new-york':      { temperature: 22, conditions: 'Partly Cloudy', humidity: 60 },
  'london':        { temperature: 12, conditions: 'Rainy', humidity: 90 },
  'tokyo':         { temperature: 26, conditions: 'Sunny', humidity: 55 },
  'paris':         { temperature: 18, conditions: 'Overcast', humidity: 70 },
  'sydney':        { temperature: 24, conditions: 'Clear', humidity: 45 },
  'berlin':        { temperature: 10, conditions: 'Cloudy', humidity: 75 },
  'dubai':         { temperature: 38, conditions: 'Sunny', humidity: 30 },
}

export function registerWeather(
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

  app.get('/api/v1/weather/:city', async (req, res) => {
    const city = req.params.city.toLowerCase().replace(/\s+/g, '-')

    const result = await mppx.charge({
      amount: '10000', // 0.01 USDC
      currency: 'USDC',
      description: `Weather for ${req.params.city}`,
    })(toWebRequest(req))

    if (result.status === 402) {
      const challenge = result.challenge as Response
      res.writeHead(challenge.status, Object.fromEntries(challenge.headers))
      res.end(await challenge.text())
      return
    }

    const data = WEATHER[city]
    if (!data) {
      const available = Object.keys(WEATHER).join(', ')
      res.status(404).json({ error: `City not found. Available: ${available}` })
      return
    }

    const response = result.withReceipt(
      Response.json({ city: req.params.city, ...data }),
    ) as Response
    logPayment(req.path, response)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(await response.text())
  })
}
