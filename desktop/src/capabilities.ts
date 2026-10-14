// What each permission means, and files the assistant suggests removing. Pure functions and copy,
// so the components stay layout.

import type { Capability } from "./types";

/** What the user is asked, and told, about a capability. The pill and Boundaries share it. */
export type CapabilityCopy = {
  name: string;
  /** The question on the permission card. */
  ask: string;
  does: string[];
  never: string[];
};

export const CAPABILITIES: Record<Capability, CapabilityCopy> = {
  browserControl: {
    name: "Browser control",
    ask: "Let the browser agent use Chrome?",
    does: ["Opens tabs, searches, clicks and plays in your Chrome", "Uses the Claude in Chrome extension", "Starts only when you press Go"],
    never: ["Signs in, buys, posts or sends anything", "Types passwords or payment details", "Touches your files or runs commands"],
  },
  recycleFiles: {
    name: "Recycling files",
    ask: "Let Mission Control move suggested files to the Recycle Bin?",
    does: ["Moves only files you confirm, one batch at a time", "Only from a folder you handed over", "You can restore them from the Recycle Bin"],
    never: ["Deletes anything permanently", "Lets an agent remove files by itself"],
  },
  mediaControls: {
    name: "Media controls",
    ask: "Show what's playing and let you control it from the pill?",
    does: ["Shows the title playing in Chrome or another app", "Play, pause, skip and change the volume from the pill"],
    never: ["Records or sends what you play anywhere", "Starts anything on its own"],
  },
};

/**
 * Splits an assistant's answer into what to show and the files it suggests removing, which it
 * lists in a fenced block that starts with ```recycle.
 */
export function recycleSuggestions(result: string | null): { text: string; paths: string[] } {
  if (!result) return { text: "", paths: [] };
  const match = result.match(/```recycle[^\n]*\n([\s\S]*?)```/);
  if (!match) return { text: result.trim(), paths: [] };
  const paths = [
    ...new Set(
      match[1]
        .split("\n")
        .map((line) => line.trim().replace(/^[-*]\s+/, "").replace(/^`|`$/g, ""))
        .filter((line) => line.length > 0),
    ),
  ];
  return { text: result.replace(match[0], "").trim(), paths };
}

/** 6.2 GB, 120 MB, 4 KB. */
export function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit >= 3 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "Recycle 4 files · 6.2 GB". */
export function recycleLabel(count: number, bytes: number | null): string {
  const files = `${count} file${count === 1 ? "" : "s"}`;
  return bytes === null ? `Recycle ${files}` : `Recycle ${files} · ${humanBytes(bytes)}`;
}

/** The size in a describe_paths detail line such as "ISO · 6.1 GB", in bytes. */
export function sizeFromDetail(detail: string): number | null {
  const match = detail.match(/([\d.]+)\s*(B|KB|MB|GB|TB)$/);
  if (!match) return null;
  const power = ["B", "KB", "MB", "GB", "TB"].indexOf(match[2]);
  return Math.round(parseFloat(match[1]) * 1024 ** power);
}
