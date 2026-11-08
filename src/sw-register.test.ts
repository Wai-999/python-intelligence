import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./sw-register";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("service worker registration", () => {
  it("registers below the deployment base, bypassing HTTP cache for updates", async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    expect(await registerServiceWorker("/python-intelligence/", true)).toBe(registration);
    const scope = new URL("/python-intelligence/", document.baseURI).href;
    expect(register).toHaveBeenCalledWith(`${scope}sw.js`, { scope, updateViaCache: "none" });
  });
  it("does not register in development or unsupported browsers", async () => {
    const register = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    await registerServiceWorker("./", false);
    expect(register).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", {});
    expect(await registerServiceWorker("./", true)).toBeUndefined();
  });
  it("handles denied registration without breaking startup", async () => {
    vi.stubGlobal("navigator", { serviceWorker: { register: vi.fn().mockRejectedValue(new Error("denied")) } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await registerServiceWorker("./", true)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
