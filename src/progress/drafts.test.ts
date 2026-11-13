import { describe, expect, it } from "vitest";
import { groupDrafts } from "./drafts";

describe("groupDrafts", () => {
  it("keeps step ids that contain colons", () => {
    expect({ ...groupDrafts({ "a:b:c": "x", "a:d": "y" }).a }).toEqual({ "b:c": "x", d: "y" });
  });

  it("treats prototype names as ordinary lesson and step ids", () => {
    const g: Record<string, Record<string, string>> = groupDrafts({ "__proto__:polluted": "1", "constructor:leak": "2", "toString:x": "3", "a:__proto__": "4" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object as unknown as Record<string, unknown>).leak).toBeUndefined();
    expect(Object.hasOwn(g, "__proto__") && g["__proto__"]!.polluted).toBe("1");
    expect(g["constructor"]!["leak"]).toBe("2");
    expect(g["toString"]!["x"]).toBe("3");
    expect(Object.hasOwn(g.a!, "__proto__") && g.a!["__proto__"]).toBe("4");
  });
});
