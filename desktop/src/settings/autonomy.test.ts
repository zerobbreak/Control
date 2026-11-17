import { describe, expect, it } from "vitest";
import { addItem, appAccessOf, autonomyOf, autonomyPatch } from "./autonomy";

describe("autonomy", () => {
  it("reads the level from the two flags", () => {
    expect(autonomyOf({ readOnlyMode: true, fullAutonomy: false })).toBe("look");
    expect(autonomyOf({ readOnlyMode: false, fullAutonomy: false })).toBe("ask");
    expect(autonomyOf({ readOnlyMode: false, fullAutonomy: true })).toBe("full");
    expect(autonomyOf({ readOnlyMode: true, fullAutonomy: true })).toBe("look");
  });

  it("round-trips every level", () => {
    for (const level of ["look", "ask", "full"] as const) expect(autonomyOf(autonomyPatch(level))).toBe(level);
  });
});

describe("appAccessOf", () => {
  it("defaults to ask", () => {
    expect(appAccessOf({ appAccess: { claude_ai_Notion: "act" } }, "claude_ai_Notion")).toBe("act");
    expect(appAccessOf({ appAccess: {} }, "claude_ai_Gmail")).toBe("ask");
  });
});

describe("addItem", () => {
  it("trims and skips blanks and duplicates", () => {
    expect(addItem(["npm test"], "  cargo test ")).toEqual(["npm test", "cargo test"]);
    expect(addItem(["npm test"], "npm test")).toEqual(["npm test"]);
    expect(addItem(["npm test"], "  ")).toEqual(["npm test"]);
  });
});
