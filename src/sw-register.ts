/** Register only the production shell; Vite's development module graph is not cacheable. */
export async function registerServiceWorker(
  nav: Navigator = navigator,
  prod = import.meta.env.PROD,
): Promise<ServiceWorkerRegistration | null> {
  if (!prod || !("serviceWorker" in nav)) return null;
  try {
    return await nav.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("Offline support could not be enabled.", error);
    return null;
  }
}

/**
 * Resolve once the page is controlled by the service worker (or immediately when that can't or won't happen),
 * waiting at most `timeoutMs`. Starting the Python worker after this means that on a learner's very first visit
 * the worker script and Pyodide downloads go through the service worker, so Python works offline afterwards.
 */
export function waitForController(nav: Navigator = navigator, prod = import.meta.env.PROD, timeoutMs = 4000): Promise<void> {
  if (!prod || !("serviceWorker" in nav) || nav.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); nav.serviceWorker.removeEventListener("controllerchange", done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    nav.serviceWorker.addEventListener("controllerchange", done);
  });
}
