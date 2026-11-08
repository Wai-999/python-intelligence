/** Register only the production shell; Vite's development module graph is not cacheable. */
export async function registerServiceWorker(
  baseUrl = import.meta.env.BASE_URL,
  production = import.meta.env.PROD,
): Promise<ServiceWorkerRegistration | undefined> {
  if (!production || !("serviceWorker" in navigator)) return undefined;
  const scope = new URL(baseUrl, document.baseURI);
  try {
    return await navigator.serviceWorker.register(new URL("sw.js", scope).href, {
      scope: scope.href,
      updateViaCache: "none",
    });
  } catch (error) {
    // Browsing and Python remain available if storage or SW registration is blocked.
    console.warn("Offline support could not be enabled.", error);
    return undefined;
  }
}
