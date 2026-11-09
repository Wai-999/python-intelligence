import { cite, CATALOG, type Citation } from "./citations";
import type { CatalogSource, Lesson } from "./types";

export interface LibraryUse { lessonId: string; lessonTitle: string; citations: Citation[] }
export interface LibraryEntry { sourceId: string; source: CatalogSource; uses: LibraryUse[] }

/**
 * Every catalogued source with the lessons that cite it, in curriculum order: one bookshelf combining
 * all the books and docs the lessons draw on. Books come before documentation pages; within each group,
 * the most-used source comes first (ties keep catalog order).
 */
export function buildLibrary(lessons: Lesson[], catalog: Record<string, CatalogSource> = CATALOG): LibraryEntry[] {
  const entries = Object.entries(catalog).map(([sourceId, source], order) => {
    const uses: LibraryUse[] = [];
    for (const l of lessons) {
      const citations = l.sources.filter((s) => s.source_id === sourceId)
        .map((s) => cite(s, catalog)).filter((c): c is Citation => c !== null);
      if (citations.length) uses.push({ lessonId: l.id, lessonTitle: l.title, citations });
    }
    return { sourceId, source, uses, order };
  });
  const group = (e: { source: CatalogSource }) => (e.source.kind === "web" ? 1 : 0);
  entries.sort((a, b) => group(a) - group(b) || b.uses.length - a.uses.length || a.order - b.order);
  return entries.map(({ order: _order, ...e }) => e);
}
