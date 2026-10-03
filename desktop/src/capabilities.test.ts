import { describe, expect, it } from "vitest";
import { CAPABILITIES, humanBytes, recycleLabel, recycleSuggestions, sizeFromDetail } from "./capabilities";

describe("recycleSuggestions", () => {
  it("takes the suggested files out of the answer", () => {
    const answer = [
      "Mostly installers. The ISO and the extra installers are safe to remove.",
      "",
      "```recycle",
      "C:\\Users\\me\\Downloads\\Win11.iso",
      "- C:\\Users\\me\\Downloads\\node (1).msi",
      "C:\\Users\\me\\Downloads\\Win11.iso",
      "```",
    ].join("\n");
    expect(recycleSuggestions(answer)).toEqual({
      text: "Mostly installers. The ISO and the extra installers are safe to remove.",
      paths: ["C:\\Users\\me\\Downloads\\Win11.iso", "C:\\Users\\me\\Downloads\\node (1).msi"],
    });
  });

  it("leaves an answer without suggestions alone", () => {
    expect(recycleSuggestions("Nothing to remove.")).toEqual({ text: "Nothing to remove.", paths: [] });
    expect(recycleSuggestions(null)).toEqual({ text: "", paths: [] });
  });
});

describe("sizes", () => {
  it("reads and writes sizes the way the pill shows them", () => {
    expect(humanBytes(6.1 * 1024 ** 3)).toBe("6.1 GB");
    expect(humanBytes(120 * 1024 ** 2)).toBe("120 MB");
    expect(sizeFromDetail("ISO · 6.1 GB")).toBe(Math.round(6.1 * 1024 ** 3));
    expect(sizeFromDetail("Folder")).toBeNull();
    expect(recycleLabel(4, 6.2 * 1024 ** 3)).toBe("Recycle 4 files · 6.2 GB");
    expect(recycleLabel(1, null)).toBe("Recycle 1 file");
  });
});

describe("capabilities", () => {
  it("say what each permission does and never does", () => {
    for (const copy of Object.values(CAPABILITIES)) {
      expect(copy.ask.endsWith("?")).toBe(true);
      expect(copy.does.length).toBeGreaterThan(0);
      expect(copy.never.length).toBeGreaterThan(0);
    }
  });
});
