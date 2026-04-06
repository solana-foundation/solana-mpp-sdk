/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

/**
 * One-shot service worker for standalone (non-mppx) payment link servers.
 * Used by Rust, Go, and Lua implementations.
 */

let pendingCredential: string | null = null;

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const { credential } = event.data ?? {};
  if (typeof credential === 'string') {
    pendingCredential = credential;
    event.ports[0]?.postMessage({ received: true });
  }
});

self.addEventListener('fetch', (event: FetchEvent) => {
  if (!pendingCredential) return;
  if (event.request.mode !== 'navigate') return;

  const credential = pendingCredential;
  pendingCredential = null;

  event.respondWith(
    (async () => {
      const headers = new Headers(event.request.headers);
      headers.set('Authorization', credential.startsWith('Payment ') ? credential : `Payment ${credential}`);
      const modifiedRequest = new Request(event.request, { headers });
      const response = await fetch(modifiedRequest);
      self.registration.unregister();
      return response;
    })(),
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
