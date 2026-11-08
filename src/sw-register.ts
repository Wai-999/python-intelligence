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
