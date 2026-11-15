import { useEffect, useState } from "react";

/**
 * Connection status for the header (§10 "clear offline status"). Offline, lessons keep working because the site's files
 * are cached; Python works only if it was downloaded on an earlier visit. Online, "Works offline" appears once the
 * service worker controls the page. No network requests are made to find this out.
 */
export function ConnectionStatus() {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [controlled, setControlled] = useState(() => typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    const ctl = () => setControlled(!!navigator.serviceWorker?.controller);
    addEventListener("online", on);
    addEventListener("offline", off);
    navigator.serviceWorker?.addEventListener("controllerchange", ctl);
    return () => { removeEventListener("online", on); removeEventListener("offline", off); navigator.serviceWorker?.removeEventListener("controllerchange", ctl); };
  }, []);
  return (
    // aria-live, not role="status": the header is on every page, and pages keep their own status regions.
    <span className={`conn ${online ? "online" : "offline"}`} aria-live="polite">
      {online ? (controlled ? <span className="muted">Works offline</span> : null)
        : <><span aria-hidden="true">⚠ </span>Offline<span className="conn-detail">: lessons work; Python runs if downloaded earlier</span></>}
    </span>
  );
}
