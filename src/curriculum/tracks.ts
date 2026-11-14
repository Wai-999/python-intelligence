import type { Lesson } from "../content/types";

/** The course's tracks, in the order the curriculum graph uses, with the names learners see. */
export const TRACK_ORDER: Lesson["track"][] = ["python-core", "data", "statistics", "ml", "projects"];
export const TRACK_LABEL: Record<Lesson["track"], string> = {
  "python-core": "Python core", data: "Data", statistics: "Statistics", ml: "Machine learning", projects: "Projects",
};
