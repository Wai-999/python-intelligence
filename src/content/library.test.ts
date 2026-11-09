import { describe, expect, it } from "vitest";
import { buildLibrary } from "./library";
import { CATALOG } from "./citations";
import { LESSONS } from "./lessons";
import type { CatalogSource, Lesson } from "./types";

const book = (short: string, extra: Partial<CatalogSource> = {}): CatalogSource => ({
  title: short, short, authors: ["A"], license: "CC", license_url: "u", official_url: "o", page_count: 100,
  page_label_offset: null, page_label_from: null, ...extra,
});
const lesson = (id: string, refs: [string, string][]): Lesson => ({
  id, title: id.toUpperCase(), sources: refs.map(([rid, sid]) => ({ id: rid, source_id: sid, pages: [1, 2], section: "S", use: "reference" })),
} as unknown as Lesson);

describe("buildLibrary", () => {
  it("lists each source once with every lesson that cites it, books before docs, most used first", () => {
    const cat = { a: book("A"), b: book("B"), w: book("W", { kind: "web", anchors: {} }) };
    const lib = buildLibrary([lesson("l1", [["x", "a"], ["y", "w"]]), lesson("l2", [["p", "b"], ["q", "b"], ["r", "a"]]),
                              lesson("l3", [["s", "b"]]), lesson("l4", [["t", "b"]])], cat);
    expect(lib.map((e) => e.sourceId)).toEqual(["b", "a", "w"]);
    expect(lib[0]!.uses.map((u) => [u.lessonId, u.citations.length])).toEqual([["l2", 2], ["l3", 1], ["l4", 1]]);
    // "a" is cited by two lessons, the doc "w" by one; books come before docs regardless.
    expect(lib[1]!.uses.map((u) => u.lessonId)).toEqual(["l1", "l2"]);
  });

  it("keeps sources nobody cites yet, so the shelf shows every approved book", () => {
    const lib = buildLibrary([], { a: book("A") });
    expect(lib).toHaveLength(1);
    expect(lib[0]!.uses).toEqual([]);
  });

  it("every book in the real catalog is used by at least one lesson", () => {
    const unused = buildLibrary(LESSONS, CATALOG).filter((e) => e.source.kind !== "web" && !e.uses.length);
    expect(unused.map((e) => e.sourceId)).toEqual([]);
  });

  it("marks the reference-only books from the generated catalog", () => {
    const ref = Object.entries(CATALOG).filter(([, s]) => s.reference_only).map(([id]) => id).sort();
    expect(ref).toEqual(["pch-bigbooksmallpythonprojects", "pch-mml-book"]);
  });
});
