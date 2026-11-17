import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff";

describe("parseDiff", () => {
  it("numbers removals by the old file and the rest by the new one", () => {
    const text = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -18,4 +18,5 @@ export function withSession(handler)",
      "   const session = 1;",
      "-  httpOnly: true,",
      "+  httpOnly: true,",
      "+  sameSite: \"lax\",",
      "   return handler;",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const diff = parseDiff(text);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.lines).toEqual([
      { kind: "hunk", text: "export function withSession(handler)", number: null },
      { kind: "ctx", text: "  const session = 1;", number: 18 },
      { kind: "del", text: "  httpOnly: true,", number: 19 },
      { kind: "add", text: "  httpOnly: true,", number: 19 },
      { kind: "add", text: '  sameSite: "lax",', number: 20 },
      { kind: "ctx", text: "  return handler;", number: 21 },
      { kind: "note", text: "No newline at end of file", number: null },
    ]);
  });

  it("handles new files, CRLF and the runtime's cut-short notice", () => {
    const text = "--- /dev/null\r\n+++ b/new.txt\r\n@@ -0,0 +1 @@\r\n+hello\r\n… diff cut short; open the file to see the rest\r\n";
    const diff = parseDiff(text);
    expect(diff.lines.map((l) => [l.kind, l.number])).toEqual([
      ["hunk", null],
      ["add", 1],
      ["note", null],
    ]);
  });

  it("says when a file is binary", () => {
    expect(parseDiff("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n").lines).toEqual([
      { kind: "note", text: "Binary file; there is no text to compare.", number: null },
    ]);
  });

  it("is empty for no diff", () => {
    expect(parseDiff("")).toEqual({ lines: [], added: 0, removed: 0 });
  });
});
