// Shell revisions may change without discarding the version-pinned runtime.
const SHELL = "pi-v1";
const RUNTIME = "pi-pyodide-0.27.8";
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.8/full/";
const base = new URL(self.registration.scope);
const index = new URL("./index.html", base).href;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll([base.href, index]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("pi-") && name !== SHELL && name !== RUNTIME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const local = url.origin === base.origin && url.pathname.startsWith(base.pathname);
  const navigation = local && request.mode === "navigate";
  const runtime = url.href.startsWith(PYODIDE);
  const asset = local && url.pathname.startsWith(`${base.pathname}assets/`) && /-[\w-]+\.[\w.]+$/.test(url.pathname);
  if (!navigation && !runtime && !asset) return;

  event.respondWith((async () => {
    const cache = await caches.open(runtime ? RUNTIME : SHELL);
    // Keep writes alive without delaying delivery or WASM streaming compilation.
    const remember = (key, response) => {
      if (response.ok && response.type !== "opaque") {
        event.waitUntil(cache.put(key, response.clone()).catch(() => {}));
      }
      return response;
    };
    if (navigation) {
      try {
        return remember(base.href, await fetch(request));
      } catch (error) {
        const cached = await cache.match(base.href) || await cache.match(index);
        if (cached) return cached;
        throw error;
      }
    }
    const cached = await cache.match(request);
    if (cached) return cached;
    return remember(request, await fetch(request));
  })());
});
