import { describe, expect, it } from "vitest";
import css from "./styles.css?raw";

// WCAG 1.4.11 non-text contrast for the tokens that draw state-carrying edges (inputs, step dots, badges) and the focus
// ring, in both colour schemes, measured with the WCAG relative-luminance formula against every background they sit on.
const block = (start: string) => {
  const i = css.indexOf(start);
  if (i < 0) throw new Error(`no block ${start}`);
  return css.slice(i, css.indexOf("}", i));
};
const tokens = (text: string) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
const light = tokens(block(":root {"));
const dark = { ...light, ...tokens(block("@media (prefers-color-scheme: dark)")) };

const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe("contrast tokens", () => {
  it("measures known pairs like the WCAG formula", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
  for (const [scheme, t] of [["light", light], ["dark", dark]] as const) {
    it(`--border-strong has at least 3:1 on every background (${scheme})`, () => {
      for (const bg of ["bg", "surface", "surface-2"]) expect(contrast(t["border-strong"]!, t[bg]!), `${bg}`).toBeGreaterThanOrEqual(3);
    });
    it(`--focus has at least 3:1 on the surfaces and the inner halo separates it from code (${scheme})`, () => {
      for (const bg of ["bg", "surface", "surface-2"]) expect(contrast(t.focus!, t[bg]!), `${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.focus!, t.surface!)).toBeGreaterThanOrEqual(3); // the halo is --surface, drawn between ring and code
    });
    it(`--hl-edge marks the active trace line with at least 3:1 on code (${scheme})`, () => {
      expect(contrast(t["hl-edge"]!, t["code-bg"]!)).toBeGreaterThanOrEqual(3);
    });
  }
});
