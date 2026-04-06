// Minimal HTTP test server for Lua payment-link Playwright tests.
// Reads the shared HTML assets from html/dist/ and serves the same page
// structure that lua/mpp/server/html.lua would produce.
//
// Unlike the Rust/Go servers, this doesn't use the Lua SDK for verification.
// Instead it parses the credential, extracts the transaction, and broadcasts
// it directly via RPC — proving the transaction hits surfpool.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const paymentUiJs = readFileSync(resolve(ROOT, 'html/dist/payment-ui.js'), 'utf8');
const serviceWorkerJs = readFileSync(resolve(ROOT, 'html/dist/service-worker.js'), 'utf8');

const PORT = parseInt(process.env.PORT ?? '3003', 10);
const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8899';
const SECRET = 'test-secret-key-long-enough-for-hmac';
const RECIPIENT = 'CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Fund recipient via surfpool cheatcodes at startup.
async function fundRecipient() {
  const call = (method, params) => fetch(RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).catch(() => {});
  await call('surfnet_setAccount', [RECIPIENT, { lamports: 1_000_000_000, data: '', executable: false, owner: '11111111111111111111111111111111', rentEpoch: 0 }]);
  await call('surfnet_setTokenAccount', [RECIPIENT, USDC_MINT, { amount: 0, state: 'initialized' }, TOKEN_PROGRAM]);
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function makeChallenge() {
  const request = {
    amount: '10000', currency: USDC_MINT, recipient: RECIPIENT,
    description: 'Open a fortune cookie',
    methodDetails: { network: 'localnet', decimals: 6 },
  };
  const requestB64 = base64url(JSON.stringify(request));
  const hmacData = `MPP Payment|solana|charge|${requestB64}`;
  const id = createHmac('sha256', SECRET).update(hmacData).digest('base64url');
  const expires = new Date(Date.now() + 300_000).toISOString();
  return { id, realm: 'MPP Payment', method: 'solana', intent: 'charge', request: requestB64, expires, description: 'Open a fortune cookie' };
}

function wwwAuthenticate(c) {
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const parts = [`id="${esc(c.id)}"`, `realm="${esc(c.realm)}"`, `method="${esc(c.method)}"`, `intent="${esc(c.intent)}"`, `request="${esc(c.request)}"`];
  if (c.expires) parts.push(`expires="${esc(c.expires)}"`);
  if (c.description) parts.push(`description="${esc(c.description)}"`);
  return `Payment ${parts.join(', ')}`;
}

function htmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderPage(challenge) {
  const embedded = JSON.stringify({ challenge, network: 'localnet', rpcUrl: RPC_URL, testMode: true });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Required</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 20px; background: #f7fafc; color: #1a202c; }
pre { background: #edf2f7; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; max-width: 600px; margin: 20px auto; }
</style>
</head>
<body>
<details style="max-width:600px;margin:0 auto 20px">
<summary style="cursor:pointer;color:#718096;font-size:14px">Challenge details</summary>
<pre>${htmlEscape(JSON.stringify(challenge, null, 2))}</pre>
</details>
<div id="root"></div>
<script type="application/json" id="__MPP_DATA__">${embedded}</script>
<script>${paymentUiJs}</script>
</body>
</html>`;
}

// Parse credential from Authorization header and broadcast the transaction.
async function verifyAndBroadcast(authHeader) {
  const token = authHeader.slice('Payment '.length);
  const json = JSON.parse(Buffer.from(token, 'base64url').toString());
  const { payload } = json;
  if (payload?.type !== 'transaction' || !payload.transaction) {
    throw new Error('Expected transaction payload');
  }
  // Broadcast the fully-signed transaction via RPC.
  const resp = await fetch(RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [payload.transaction, { encoding: 'base64', skipPreflight: false }] }),
  });
  const result = await resp.json();
  if (result.error) throw new Error(`sendTransaction: ${result.error.message}`);
  return result.result; // signature
}

const CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src *; worker-src 'self'";

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  if (url.pathname === '/fortune') {
    // Authenticated — verify and broadcast.
    const auth = req.headers['authorization'] ?? '';
    if (auth.startsWith('Payment ')) {
      try {
        const sig = await verifyAndBroadcast(auth);
        console.log(`✓ /fortune  tx: ${sig}`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Payment-Receipt': sig });
        return res.end(JSON.stringify({ fortune: 'A smooth long journey!' }));
      } catch (e) {
        console.error('verify failed:', e.message);
        // Fall through to re-issue challenge.
      }
    }

    // Service worker.
    if (url.searchParams.has('__mpp_worker')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' });
      return res.end(serviceWorkerJs);
    }

    const accept = req.headers['accept'] ?? '';
    const challenge = makeChallenge();
    const authenticate = wwwAuthenticate(challenge);

    // Browser — HTML.
    if (accept.includes('text/html')) {
      res.writeHead(402, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'WWW-Authenticate': authenticate });
      return res.end(renderPage(challenge));
    }

    // API client — JSON 402.
    res.writeHead(402, { 'Content-Type': 'application/json', 'WWW-Authenticate': authenticate });
    return res.end(JSON.stringify({ error: 'Payment Required' }));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

await fundRecipient();
httpServer.listen(PORT, () => console.log(`Lua e2e test server listening on http://localhost:${PORT}`));
