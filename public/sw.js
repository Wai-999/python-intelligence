/* Bump this revision when changing the shell or cache policy. Runtime files are
 * cached on use: offline Python needs one successful online run first. */
const REVISION = "v1";
const PREFIX = `python-intelligence:${self.registration.scope}:`;
const SHELL = `${PREFIX}shell:${REVISION}`;
const RUNTIME = `${PREFIX}pyodide:0.27.8:${REVISION}`;
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.8/full/";
const base = new URL(self.registration.scope);

// Discover Vite's hashed entry, styles and worker from the built shell. This
// avoids root-relative URLs and does not require a generated build manifest.
async function cacheShell() {
  const cache = await caches.open(SHELL);
  const visited = new Set();
  async function visit(url) {
    if (visited.has(url)) return;
    visited.add(url);
    const response = await fetch(url, { cache: "reload" });
    if (!response.ok) throw new Error(`Cannot cache ${url}: ${response.status}`);
    await cache.put(url, response.clone());
    if (!/text\/html|javascript|text\/css/.test(response.headers.get("content-type") || "")) return;
    const source = await response.text();
    const refs = [...source.matchAll(/["'`]([^"'`\s]+\.(?:js|css))["'`]/g)];
    await Promise.all(refs.map(async ([, path]) => {
      const asset = new URL(path, url);
      if (asset.origin === base.origin && asset.pathname.startsWith(`${base.pathname}assets/`) && /-[\w-]+\.(?:js|css)$/.test(asset.pathname)) await visit(asset.href);
    }));
  }
  await visit(base.href);
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell());
  // Let existing tabs finish with their current worker during an update.
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== SHELL && name !== RUNTIME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const runtime = url.href.startsWith(PYODIDE);
  const local = url.origin === base.origin && url.pathname.startsWith(base.pathname);
  if (!runtime && !local) return;
  // Never cache opaque CDN failures, other runtime versions, or arbitrary APIs.
  if (!runtime && request.mode !== "navigate" && !url.pathname.startsWith(`${base.pathname}assets/`)) return;
  event.respondWith((async () => {
    const cache = await caches.open(runtime ? RUNTIME : SHELL);
    const key = request.mode === "navigate" ? base.href : request;
    const cached = await cache.match(key);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type !== "opaque") {
      // A quota/storage failure must not prevent a successful online response.
      await cache.put(key, response.clone()).catch(() => {});
    }
    return response;
  })());
});
