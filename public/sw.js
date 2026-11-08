// Two caches let shell revisions be cleaned up without discarding the large,
// version-pinned Pyodide runtime, which is populated only when Python is used.
const SHELL = "pi-v1";
const RUNTIME = "pi-pyodide-0.27.8";
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.8/full/";
const base = new URL(self.registration.scope);
const index = new URL("./index.html", base).href;

// Workers have no DOMParser. Vite emits script/link tags with URL attributes.
function references(html) {
  const urls = new Set();
  for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attribute = tag[1].toLowerCase() === "script" ? "src" : "href";
    const match = tag[0].match(new RegExp(`\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    if (!match) continue;
    const url = new URL((match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, "&"), index);
    if (url.origin === base.origin) urls.add(url.href);
  }
  return [...urls];
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const response = await fetch(index, { cache: "reload" });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
      throw new Error("The offline shell must be HTML");
    }
    const assets = references(await response.clone().text());
    await cache.addAll(assets);
    await cache.put(index, response.clone());
    await cache.put(base.href, response);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("pi-") && name !== SHELL && name !== RUNTIME)
      .map((name) => caches.delete(name)));
    const cache = await caches.open(SHELL);
    const shell = await cache.match(index);
    if (shell) {
      const current = new Set(references(await shell.text()));
      await Promise.all((await cache.keys()).filter((request) => {
        const url = new URL(request.url);
        const path = url.pathname.slice(base.pathname.length);
        // Retain runtime-loaded chunks such as the Pyodide worker.
        return url.origin === base.origin && url.pathname.startsWith(base.pathname)
          && /^assets\/(?:.*\.css|index-[^/]+\.js)$/.test(path) && !current.has(url.href);
      }).map((request) => cache.delete(request)));
    }
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
  const asset = local && url.pathname !== new URL("./sw.js", base).pathname;
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
        const response = await fetch(request);
        if ((url.pathname === base.pathname || url.pathname === new URL(index).pathname)
          && response.headers.get("content-type")?.includes("text/html")) {
          return remember(base.href, response);
        }
        return response;
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
