/**
 * HTML payment link support for browser-based payments.
 *
 * When enabled, 402 responses can be rendered as interactive HTML payment pages.
 * The page embeds a bundled Solana payment UI that handles wallet connection,
 * transaction signing, and credential submission via a service worker.
 *
 * @example
 * ```ts
 * import { html } from '@solana/mpp/server/html'
 *
 * // In your HTTP handler:
 * if (html.acceptsHtml(request.headers.get('accept'))) {
 *   if (html.isServiceWorkerRequest(request.url)) {
 *     return new Response(html.serviceWorkerJs(), {
 *       headers: {
 *         'Content-Type': 'application/javascript',
 *         'Service-Worker-Allowed': '/',
 *       },
 *     })
 *   }
 *   const challenge = await mppx.charge({ amount: '10000', currency: 'USDC' })(request)
 *   if (challenge.status === 402) {
 *     return html.respondWithPaymentPage(challenge.challenge)
 *   }
 * }
 * ```
 */

import { PAYMENT_UI_JS, SERVICE_WORKER_JS } from './html-assets.gen.js';

/** Query parameter that triggers serving the service worker JS. */
export const SERVICE_WORKER_PARAM = '__mpp_worker';

/** ID of the embedded data script element. */
const DATA_ELEMENT_ID = '__MPP_DATA__';

/** Check if an HTTP Accept header value includes text/html. */
export function acceptsHtml(accept: string | null | undefined): boolean {
    if (!accept) return false;
    return accept.split(',').some((part) => part.trim().startsWith('text/html'));
}

/** Check if a URL contains the service worker query parameter. */
export function isServiceWorkerRequest(url: string): boolean {
    return url.includes(SERVICE_WORKER_PARAM);
}

/** Returns the service worker JavaScript content. */
export function serviceWorkerJs(): string {
    return SERVICE_WORKER_JS as string;
}

/** Returns the payment UI JavaScript content (for advanced use). */
export function paymentUiJs(): string {
    return PAYMENT_UI_JS as string;
}

/** HTML-escape a string to prevent XSS. */
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

export interface ChallengeData {
    description?: string;
    digest?: string;
    expires?: string;
    id: string;
    intent: string;
    method: string;
    opaque?: string;
    realm: string;
    request: string;
}

export interface PaymentPageOptions {
    /** The payment challenge to embed in the page. */
    challenge: ChallengeData;
    /** Solana network (mainnet-beta, devnet, localnet). */
    network: string;
    /** RPC URL for the payment UI to use. */
    rpcUrl: string;
}

/**
 * Render a payment challenge as a self-contained HTML payment page.
 *
 * The returned HTML includes the challenge data and inlined payment UI script.
 * All user-controlled values are HTML-escaped to prevent XSS.
 */
export function challengeToHtml(options: PaymentPageOptions): string {
    const { challenge, network, rpcUrl } = options;
    const testMode = network === 'devnet' || network === 'localnet';
    const challengeJson = JSON.stringify(challenge, null, 2);

    const embeddedData = JSON.stringify({
        challenge,
        network,
        rpcUrl,
        testMode,
    });

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
<pre>${escapeHtml(challengeJson)}</pre>
</details>
<div id="root"></div>
<script type="application/json" id="${DATA_ELEMENT_ID}">${embeddedData}</script>
<script>${PAYMENT_UI_JS}</script>
</body>
</html>`;
}

/**
 * Create a full 402 HTML Response for a payment challenge.
 *
 * Sets Content-Type, Content-Security-Policy, WWW-Authenticate, and Cache-Control headers.
 */
export function respondWithPaymentPage(
    options: PaymentPageOptions & { wwwAuthenticate: string },
): Response {
    const html = challengeToHtml(options);
    return new Response(html, {
        headers: {
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
                "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src *; worker-src 'self'",
            'Content-Type': 'text/html; charset=utf-8',
            'WWW-Authenticate': options.wwwAuthenticate,
        },
        status: 402,
    });
}
