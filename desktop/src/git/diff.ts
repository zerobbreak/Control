// Turns `git diff` output for one file into numbered lines for the Changes diff viewer.

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "note";

export type DiffLine = {
  kind: DiffLineKind;
  /** The line without its leading +, - or space. */
  text: string;
  /** The old file's line number for removals, the new file's otherwise; null for hunks and notes. */
  number: number | null;
};

export type ParsedDiff = { lines: DiffLine[]; added: number; removed: number };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

export function parseDiff(text: string): ParsedDiff {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = 0;
  let newNo = 0;
  // File headers (diff --git, index, ---/+++ and the like) say nothing the viewer's title doesn't.
  let inHeader = true;

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("diff ")) {
      inHeader = true;
      continue;
    }
    const hunk = raw.match(HUNK);
    if (hunk) {
      inHeader = false;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: "hunk", text: hunk[3] ?? "", number: null });
      continue;
    }
    if (inHeader) {
      if (raw.startsWith("Binary files")) lines.push({ kind: "note", text: "Binary file; there is no text to compare.", number: null });
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), number: newNo++ });
      added++;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), number: oldNo++ });
      removed++;
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "ctx", text: raw.slice(1), number: newNo++ });
      oldNo++;
    } else if (raw.startsWith("\\")) {
      lines.push({ kind: "note", text: raw.slice(1).trim(), number: null });
    } else if (raw.trim() !== "") {
      lines.push({ kind: "note", text: raw.trim(), number: null });
    }
  }
  return { lines, added, removed };
}
