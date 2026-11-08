import { describe, expect, it } from "vitest";
import { cite, pageRange, printedPage } from "./citations";
import type { CatalogSource } from "./types";

const numbered: CatalogSource = {
  title: "Book A", short: "A", authors: ["X", "Y"], license: "CC BY-NC 3.0", license_url: "https://l", official_url: "https://a",
  page_count: 200, page_label_offset: 22, page_label_from: 23,
};
const unnumbered: CatalogSource = { ...numbered, short: "B", page_label_offset: null, page_label_from: null };

describe("citations", () => {
  it("maps physical pages to printed pages from the first numbered page", () => {
    expect(printedPage(numbered, 62)).toBe(40);
    expect(printedPage(numbered, 10)).toBeNull(); // front matter
  });

  it("formats printed ranges, single pages, and books without printed numbers", () => {
    expect(pageRange(numbered, [62, 64])).toBe("pp. 40–42");
    expect(pageRange(numbered, [62, 62])).toBe("p. 40");
    expect(pageRange(numbered, [10, 30])).toBe("PDF pp. 10–30"); // straddles front matter: stay unambiguous
    expect(pageRange(unnumbered, [54, 55])).toBe("PDF pp. 54–55");
  });

  it("builds a citation, and returns null for an unknown source instead of throwing", () => {
    const ref = { id: "a", source_id: "a", pages: [62, 64] as [number, number], section: "Booleans", use: "reference" as const };
    expect(cite(ref, { a: numbered })).toMatchObject({ book: "A", authors: "X, Y", pages: "pp. 40–42", adapted: false });
    expect(cite({ ...ref, source_id: "zzz" }, { a: numbered })).toBeNull();
  });
});
