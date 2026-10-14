// Files as context and connected apps, as the pill shows them. Pure functions, so the component stays layout.

import type { AvatarRole } from "./avatar/blob";
import type { App, ContextItem, ContextKind, Preview, TaskKind } from "./types";
import { fileName } from "./runs";

/**
 * Splits what was handed over into the project the goal runs in, the first code project, and the
 * files and folders it reads as context. A loose folder such as Downloads is never run in, only
 * looked at. Missing paths are left out.
 */
export function splitContext(items: ContextItem[]): { folder: string | null; attachments: string[] } {
  const present = items.filter((i) => i.kind !== "missing");
  const project = present.find((i) => i.kind === "folder" && i.project) ?? null;
  return { folder: project?.path ?? null, attachments: present.filter((i) => i !== project).map((i) => i.path) };
}

const KIND_NOUN: Record<ContextKind, [string, string]> = {
  folder: ["folder", "folders"],
  image: ["image", "images"],
  pdf: ["PDF", "PDFs"],
  link: ["link", "links"],
  file: ["file", "files"],
  missing: ["missing", "missing"],
};

/** "1 folder", "2 images", "1 PDF": what is being dropped, by kind, in a steady order. */
export function contextCounts(items: ContextItem[]): string[] {
  const order: ContextKind[] = ["folder", "image", "pdf", "link", "file"];
  return order.flatMap((kind) => {
    const n = items.filter((i) => i.kind === kind).length;
    return n === 0 ? [] : [`${n} ${KIND_NOUN[kind][n === 1 ? 0 : 1]}`];
  });
}

/** The `@word` being typed at the caret, if any, so the pill can offer apps and files for it. */
export function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return { query: match[2], start: caret - match[2].length - 1 };
}

/** Replaces the `@word` at the caret with `@Name `, returning the new text and caret. */
export function insertMention(text: string, caret: number, name: string): { text: string; caret: number } {
  const mention = mentionAt(text, caret);
  if (!mention) return { text, caret };
  const token = `@${name.replace(/\s+/g, "")} `;
  const next = text.slice(0, mention.start) + token + text.slice(caret);
  return { text: next, caret: mention.start + token.length };
}

/** A suggestion in the @ menu: an app agents can work in, or something already handed over. */
export type Mention = { kind: "app" | "context"; name: string; detail: string };

/** Apps and handed-over items whose name starts with, then contains, what has been typed. */
export function mentionOptions(query: string, apps: App[], items: ContextItem[], limit = 6): Mention[] {
  const q = query.toLowerCase();
  const all: Mention[] = [
    ...apps
      .filter((a) => a.status === "connected")
      .map((a) => ({ kind: "app" as const, name: a.name, detail: "Connected app" })),
    ...items.filter((i) => i.kind !== "missing").map((i) => ({ kind: "context" as const, name: i.name, detail: i.detail })),
  ];
  const rank = (m: Mention) => {
    const name = m.name.toLowerCase().replace(/\s+/g, "");
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
  };
  return all
    .filter((m) => rank(m) < 2)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

/** How an access level reads on a plan step, and its tone. */
export type AccessBadge = { label: string; tone: "auto" | "asks" | "read" };

/** One step of the plan shown before a mission starts. */
export type PlanStep = {
  role: AvatarRole;
  agent: string;
  /** Where it works: a project folder, "your apps", or the web. */
  where: string;
  title: string;
  detail: string;
  badge: AccessBadge;
};

const AGENT: Record<TaskKind, { role: AvatarRole; name: string }> = {
  code: { role: "code", name: "Claude" },
  question: { role: "code", name: "Claude" },
  browse: { role: "web", name: "Browser" },
  assistant: { role: "assist", name: "Assistant" },
};

/** What the run may do without asking, from its access and the Boundaries rules. */
export function accessBadge(preview: Preview): AccessBadge {
  const { access } = preview.decision;
  if (access === "readOnly") return { label: "Read only", tone: "read" };
  if (preview.fullAutonomy) return { label: "Automatic", tone: "auto" };
  if (access === "useApps") return { label: "Asks before changes", tone: "asks" };
  return preview.askBeforeEdits ? { label: "Asks first", tone: "asks" } : { label: "Edits on its own", tone: "auto" };
}

/**
 * The plan for review: the agent the router picked, doing the work where it will run, then
 * Mission Control reporting back. The router makes one decision per goal, so the plan is that
 * decision laid out, not a promise of steps the runtime does not take.
 */
export function planSteps(preview: Preview, items: ContextItem[]): PlanStep[] {
  const { task, reason } = preview.decision;
  const agent = AGENT[task];
  const project = fileName(preview.workdir);
  const files = items.filter((i) => i.kind !== "missing" && i.path !== preview.workdir).map((i) => i.name);
  const reads = files.length > 0 ? `Reads ${listNames(files)}. ` : "";
  // A read-only look at a loose folder, such as "what's taking up space in Downloads?".
  const loose = task === "assistant" && preview.decision.access === "readOnly" ? items.find((i) => i.kind === "folder" && !i.project) : undefined;
  const where = loose ? loose.name : task === "assistant" ? "Your apps" : task === "browse" ? "Chrome" : project;
  const title = loose
    ? `Look through ${loose.name}`
    : {
        code: `Make the change in ${project}`,
        question: `Look into ${project} and answer`,
        browse: "Do it in Chrome",
        assistant: "Work through your apps",
      }[task];
  return [
    { role: agent.role, agent: agent.name, where, title, detail: reads + reason, badge: accessBadge(preview) },
    {
      role: "mc",
      agent: "Mission Control",
      where: "",
      title: "Report back",
      detail: "Shows what it did here, with any link it made.",
      badge: { label: "Read only", tone: "read" },
    },
  ];
}

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
