/**
 * Groups stored drafts ("lessonId:stepId" → code) by lesson. Keys split at the first colon, since step ids may contain
 * colons, and both levels are null-prototype maps, so a key such as "__proto__:x" or "constructor:x" is just data.
 */
export function groupDrafts(drafts: Record<string, string>): Record<string, Record<string, string>> {
  const byLesson: Record<string, Record<string, string>> = Object.create(null);
  for (const [key, code] of Object.entries(drafts)) {
    const at = key.indexOf(":");
    const lessonId = key.slice(0, at), stepId = key.slice(at + 1);
    if (!Object.hasOwn(byLesson, lessonId)) byLesson[lessonId] = Object.create(null) as Record<string, string>;
    byLesson[lessonId]![stepId] = code;
  }
  return byLesson;
}
