# Payment Links — Implementation Plan

> Based on [wevm/mppx#266](https://github.com/wevm/mppx/pull/266) ("feat: payment links")

## What is this feature?

Payment links turn any payment-gated API endpoint into a **browser-payable page**. When a user navigates to a protected resource in a browser (sending `Accept: text/html`), instead of receiving a JSON `402 Payment Required` response, they see a self-contained HTML payment page that handles the full Solana payment flow.

### Intended usage

```
1. Developer enables `html: true` on a charge endpoint
2. Browser navigates to GET /api/premium-content
3. Server detects `Accept: text/html`, returns an HTML page instead of JSON 402
4. Page renders "Payment Required" + a "Pay with Solana" button
5. User clicks → wallet connects → transaction signed
6. Service worker intercepts the next page load, attaches `Authorization: Payment <credential>`
7. Browser reloads → server verifies credential → returns the actual content
```

The user never leaves the page. The service worker makes the credential submission invisible — it's a seamless redirect-free payment experience.

### Who is this for?

- **API providers** who want to offer pay-per-use access without requiring API keys or account creation
- **Content creators** selling digital goods at a URL (reports, datasets, media)
- **Any MPP-gated endpoint** that should also be accessible from a browser, not just programmatic clients

---

## Security Analysis

### How the service worker mechanism works

1. Server responds with HTML containing: challenge JSON in a `<script type="application/json">` block + bundled payment UI script
2. Payment UI registers a **service worker** scoped to the current path
3. After the user signs, the UI sends the credential to the service worker via `postMessage` + `MessageChannel`
4. The service worker sets a one-shot `fetch` listener that intercepts the next `navigate` request
5. It clones the request, adds `Authorization: Payment <base64url(credential)>`, forwards it to the server
6. The service worker **immediately unregisters itself**
7. The page calls `location.reload()`, which the service worker intercepts with the credential attached

### Attack vectors to consider

#### 1. XSS on the payment page (HIGH — mitigatable)

**Risk:** If an attacker can inject JavaScript into the HTML payment page, they can:
- Hijack the wallet signing flow (modify recipient/amount before signing)
- Exfiltrate the signed transaction before it's submitted
- Replace the service worker with a malicious one

**Mitigation:**
- The HTML template must be **static** with no user-controlled content interpolated into executable positions
- The challenge data goes into a `<script type="application/json">` block (not executable)
- Apply strict `Content-Security-Policy` headers: `script-src 'self'` (no inline, no eval)
- The `description` field from the challenge should be **text-escaped**, never rendered as HTML

**Our implementation must:** Treat all challenge fields as untrusted data when rendering into HTML. Use `textContent` in JS, never `innerHTML`. Set CSP headers.

#### 2. Service worker persistence / scope hijack (MEDIUM — mitigated by design)

**Risk:** A service worker registered on the API origin could intercept requests beyond the payment flow.

**Mitigation (already in the design):**
- The worker self-unregisters after exactly one interception
- It only listens for `navigate` fetches (not subresources)
- Scope is limited to the endpoint path
- If the browser crashes before unregistration, the worker becomes inert (no stored credential, no `fetch` listener)

**Our implementation must:** Ensure the worker calls `self.registration.unregister()` immediately after forwarding. Never store credentials in the worker's global state beyond the single `postMessage` → `fetch` cycle.

#### 3. Challenge tampering in the HTML (LOW — already mitigated)

**Risk:** An attacker modifies the embedded challenge (e.g., change recipient address) to redirect payment.

**Why this is already safe:** The server generates the challenge with an HMAC-SHA256 `id` that binds all fields together. When the credential comes back, the server recomputes the HMAC and rejects any mismatch. A modified challenge produces an invalid `id` — the server will reject it.

**No additional work needed** — the existing HMAC verification handles this.

#### 4. Replay of the HTML page (LOW — already mitigated)

**Risk:** Someone saves the HTML page and replays it later.

**Why this is already safe:** Challenges have an `expires` field (default 5 minutes). The HMAC binds the expiration. Replaying an expired challenge will be rejected server-side.

#### 5. Credential interception in transit (LOW — standard TLS)

**Risk:** MITM intercepts the credential on the replayed request.

**Mitigation:** Same as any authenticated HTTP request — requires HTTPS. The `Authorization` header is protected by TLS. No different from the existing programmatic flow.

#### 6. Origin confusion on shared domains (MEDIUM — deployment concern)

**Risk:** If multiple services share a domain (e.g., `api.example.com/service-a` and `/service-b`), one service's payment page could theoretically interfere with the other's service workers.

**Mitigation:**
- Scope service workers narrowly (use the full endpoint path as scope)
- Document that payment links should be served from dedicated paths
- The one-shot nature limits the blast radius

**Recommendation:** Add a note in docs that payment links work best on dedicated (sub)domains or clearly separated paths.

### Summary of security posture

The design is **sound**. The main new attack surface is XSS on the payment page, which is manageable with standard web security practices (CSP, proper escaping, no inline scripts in production). The HMAC challenge system and transaction verification on the server side remain the trust anchors — the HTML page is purely a convenience layer that doesn't weaken the core security model.

**Key principle:** The server never trusts the HTML page. It re-verifies everything server-side. The HTML is just a UX shell.

---

## Implementation Plan

### Phase 1: Shared JS assets (service worker infrastructure)

Create `html/` at the repo root with framework-agnostic JavaScript that all language implementations will embed.

#### 1.1 Service worker (`html/serviceWorker.js`)

```
- Listen for `message` event with credential payload
- On next `fetch` event (type: navigate), clone request + attach Authorization header
- Forward to network, unregister self
- ~30 lines
```

#### 1.2 Service worker client (`html/serviceWorker.client.js`)

```
- Register service worker from `?__mpp_worker` URL
- Wait for activation
- Send credential via MessageChannel.postMessage
- Call location.reload()
- ~20 lines
```

#### 1.3 Payment UI script (`html/solana-pay.js`)

```
- Parse challenge from embedded __MPP_DATA__ JSON block
- Decode the base64url `request` field to get ChargeRequest
- Connect to Solana wallet (Wallet Standard)
- Build transaction from challenge parameters:
  - SOL: SystemProgram.transfer
  - SPL: Token.transferChecked (handle Token-2022)
  - Splits: additional transfer instructions
  - Fee payer: partial sign only (server co-signs)
- Sign transaction
- Encode as CredentialPayload (type: "transaction")
- Build full credential JSON (challenge echo + payload)
- Base64url-encode, pass to service worker client
- ~150-200 lines
```

#### 1.4 HTML template (`html/template.html`)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Payment Required</title>
  <!-- CSP: no inline scripts, no eval -->
</head>
<body>
  <pre id="challenge"><!-- challenge JSON dump --></pre>
  <div id="root"></div>
  <script type="application/json" id="__MPP_DATA__"><!-- challenge data --></script>
  <script src="solana-pay.bundle.js"></script>
</body>
</html>
```

#### 1.5 Build script

```
- Bundle solana-pay.js + dependencies (wallet-standard, @solana/web3.js) into IIFE
- Bundle service worker + client separately
- Output as embeddable strings (for Rust: include_str!, for Go: embed, for Lua: string literal)
- Tool: esbuild or rolldown
```

### Phase 2: Rust implementation

Files to modify/create:
- `rust/src/server/mod.rs` — add `html` config option + content negotiation
- `rust/src/server/html.rs` (new) — HTML template rendering + service worker serving

#### 2.1 Config extension

```rust
// In Config:
pub html: bool,  // Enable payment link HTML responses

// In Mpp:
html: bool,
```

#### 2.2 New method: `respond_challenge_html`

```rust
/// Returns the HTML payment page response (status 402, Content-Type: text/html).
/// The challenge is embedded as JSON in a <script> tag.
/// The bundled payment UI script is inlined.
pub fn challenge_to_html(&self, challenge: &PaymentChallenge) -> String {
    // - Serialize challenge to JSON (for display + data block)
    // - HTML-escape all interpolated values
    // - Inject bundled JS (include_str! from build output)
    // - Set CSP header in the template
}
```

#### 2.3 Service worker endpoint helper

```rust
/// Returns the service worker JS content.
/// Call this when the request URL contains `?__mpp_worker`.
pub fn service_worker_js() -> &'static str {
    include_str!("../../html/dist/serviceWorker.js")
}
```

#### 2.4 Usage pattern (for axum/actix middleware authors)

```rust
// In your 402 handler:
if request_accepts_html(&headers) && mpp.html_enabled() {
    let challenge = mpp.charge("1.00")?;
    // Check for service worker request
    if url.query().contains("__mpp_worker") {
        return Response::builder()
            .header("Content-Type", "application/javascript")
            .body(Mpp::service_worker_js());
    }
    return Response::builder()
        .status(402)
        .header("Content-Type", "text/html")
        .header("WWW-Authenticate", format_www_authenticate(&challenge)?)
        .body(mpp.challenge_to_html(&challenge));
}
// else: existing JSON 402 flow
```

### Phase 3: Go implementation

Files to modify/create:
- `go/server/server.go` — add `HTML bool` to Config
- `go/server/html.go` (new) — template rendering, embed directive for JS bundles

#### 3.1 Config extension

```go
type Config struct {
    // ... existing fields ...
    HTML bool // Enable payment link HTML responses
}
```

#### 3.2 Embedded assets

```go
import "embed"

//go:embed html/dist/serviceWorker.js
var serviceWorkerJS string

//go:embed html/dist/solana-pay.bundle.js
var paymentUIJS string
```

#### 3.3 New methods

```go
// ChallengeToHTML renders the payment page HTML for the given challenge.
func (m *Mpp) ChallengeToHTML(challenge mpp.PaymentChallenge) (string, error)

// ServiceWorkerJS returns the service worker JavaScript content.
func ServiceWorkerJS() string
```

### Phase 4: Lua implementation

Files to modify/create:
- `lua/mpp/server/init.lua` — add `html` config option
- `lua/mpp/server/html.lua` (new) — template rendering with embedded JS strings

#### 4.1 Config extension

```lua
-- In M.new(config):
instance.html = config.html or false
```

#### 4.2 New functions

```lua
-- html.lua
function M.challenge_to_html(challenge_json, payment_ui_js, service_worker_client_js)
function M.service_worker_js()
```

#### 4.3 Kong/OpenResty integration

In the access phase handler, before returning 402:
```lua
if self.html and ngx.var.http_accept and ngx.var.http_accept:find('text/html') then
    ngx.status = 402
    ngx.header['Content-Type'] = 'text/html'
    ngx.header['WWW-Authenticate'] = headers.format_www_authenticate(challenge)
    ngx.say(html.challenge_to_html(challenge))
    return ngx.exit(402)
end
```

### Phase 5: TypeScript (minimal changes)

The TypeScript package uses `mppx` upstream, which already has this feature from PR #266. The main work is:
- Ensure the `html` option is exposed in the TypeScript SDK's charge method
- Pass it through to `mppx`'s `tempo.charge()` / method config

### Phase 6: Testing

#### 6.1 Unit tests (per language)

- HTML template renders valid HTML with correct challenge data
- Challenge fields are properly escaped (test with `<script>alert(1)</script>` in description)
- Service worker endpoint returns correct JS with correct Content-Type
- Content negotiation: `Accept: text/html` → HTML, `Accept: application/json` → JSON

#### 6.2 Integration tests

- Playwright/browser test: navigate to endpoint → see payment page → verify DOM structure
- Full payment flow test against localnet: page load → wallet sign → credential submission → resource access
- Test that expired challenges render a page but payment fails server-side
- Test that tampered challenge data is rejected on credential verification

#### 6.3 Security tests

- Verify CSP headers are set on HTML responses
- Verify no inline scripts in the HTML output
- Verify challenge fields with HTML/JS payloads are properly escaped
- Verify service worker unregisters after one use

---

## Open questions

1. **Wallet adapter choice**: Should we use Wallet Standard directly, or bundle a specific adapter (e.g., `@solana/wallet-adapter`)? Wallet Standard is lighter but less battle-tested in embedded contexts.

2. **Push vs pull mode in browser**: In pull mode, the client sends the signed transaction to the server. In push mode, the client broadcasts and sends the signature. Should the HTML UI support both, or default to pull mode (which is simpler and supports fee payer)?

3. **Theming**: The upstream PR notes theming is a follow-up. Should we add basic theming support (light/dark) from the start, or ship minimal UI first?

4. **Bundle size**: The Solana wallet + web3.js dependencies are heavy (~200KB+ gzipped). Should we lazy-load from CDN, or inline everything? Inlining is safer (no external dependencies) but increases response size.

5. **Test mode**: The upstream PR has a "test mode" that uses a local keypair + faucet instead of a real wallet. Should we implement this for devnet/localnet flows?
