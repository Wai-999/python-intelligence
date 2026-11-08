import type { Lesson } from "./types";

// Lessons are static JSON bundled at build time; validated by scripts/validate_content.py before every build.
const modules = import.meta.glob<{ default: Lesson }>("../../content/lessons/*.json", { eager: true });
export const LESSONS: Lesson[] = Object.values(modules).map((m) => m.default);
