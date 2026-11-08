import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker, waitForController } from "./sw-register";

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

describe("waitForController", () => {
  const fakeNav = (controller: unknown) => {
    const listeners = new Set<() => void>();
    const sw = {
      controller,
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
      fire: () => [...listeners].forEach((f) => f()),
      listeners,
    };
    return { nav: { serviceWorker: sw } as unknown as Navigator, sw };
  };

  it("resolves at once in development, without support, or when already controlled", async () => {
    await waitForController(fakeNav(null).nav, false, 10_000);
    await waitForController({} as Navigator, true, 10_000);
    await waitForController(fakeNav({}).nav, true, 10_000);
  });

  it("waits for controllerchange, then removes its listener", async () => {
    const { nav, sw } = fakeNav(null);
    let resolved = false;
    const p = waitForController(nav, true, 10_000).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    sw.fire();
    await p;
    expect(resolved).toBe(true);
    expect(sw.listeners.size).toBe(0);
  });

  it("gives up after the timeout so Python still starts", async () => {
    vi.useFakeTimers();
    const { nav } = fakeNav(null);
    const p = waitForController(nav, true, 4000);
    vi.advanceTimersByTime(4000);
    await p;
    vi.useRealTimers();
  });
});
