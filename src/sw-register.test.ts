import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./sw-register";

const navigatorWith = (register: ReturnType<typeof vi.fn>) =>
  ({ serviceWorker: { register } }) as unknown as Navigator;

afterEach(() => { vi.restoreAllMocks(); });

describe("service worker registration", () => {
  it("registers the relative worker and returns its registration", async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    expect(await registerServiceWorker(navigatorWith(register), true)).toBe(registration);
    expect(register).toHaveBeenCalledWith("./sw.js");
  });
  it("returns null in development or unsupported browsers", async () => {
    const register = vi.fn();
    expect(await registerServiceWorker(navigatorWith(register), false)).toBeNull();
    expect(register).not.toHaveBeenCalled();
    expect(await registerServiceWorker({} as Navigator, true)).toBeNull();
  });
  it("returns null on denied registration without breaking startup", async () => {
    const register = vi.fn().mockRejectedValue(new Error("denied"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await registerServiceWorker(navigatorWith(register), true)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
