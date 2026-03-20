import type { Endpoint } from './types.js'

export const SWIG_ENDPOINTS: Endpoint[] = [
  {
    method: 'GET',
    path: '/api/v1/swig/research/:topic',
    description: 'Session-backed research capsule',
    cost: '0.01 USDC / request',
    params: [{ name: 'topic', default: 'solana-payments' }],
  },
  {
    method: 'GET',
    path: '/api/v1/swig/risk/:symbol',
    description: 'Session-backed risk snapshot',
    cost: '0.01 USDC / request',
    params: [{ name: 'symbol', default: 'sol' }],
  },
]

export function buildSwigUrl(
  endpoint: Endpoint,
  paramValues: Record<string, string>,
): string {
  let url = endpoint.path
  const queryParams: string[] = []

  for (const param of endpoint.params ?? []) {
    const value = paramValues[param.name] || param.default
    if (url.includes(`:${param.name}`)) {
      url = url.replace(`:${param.name}`, encodeURIComponent(value))
    } else {
      queryParams.push(`${param.name}=${encodeURIComponent(value)}`)
    }
  }

  if (queryParams.length) url += `?${queryParams.join('&')}`
  return url
}

export function buildSwigSnippet(
  endpoint: Endpoint,
  paramValues: Record<string, string>,
): string {
  const url = buildSwigUrl(endpoint, paramValues)

  return `import { Mppx, solana } from '@solana/mpp/client'
import { SwigSessionAuthorizer } from '@solana/mpp'

// 1) Create/fetch Swig role + delegated session key on-chain
// 2) Wire adapter into SwigSessionAuthorizer
const authorizer = new SwigSessionAuthorizer({
  wallet: swigWalletAdapter,
  policy: {
    profile: 'swig-time-bound',
    ttlSeconds: 180,
    spendLimit: '30000',
    depositLimit: '30000',
  },
  rpcUrl: 'http://localhost:8899',
  allowedPrograms: ['swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB'],
})

const method = solana.session({ signer, authorizer })
const mppx = Mppx.create({ methods: [method] })

const response = await mppx.fetch('${url}')
const data = await response.json()
console.log(data)`
}
