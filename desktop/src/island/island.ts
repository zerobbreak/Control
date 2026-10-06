// How the island reads: which face it wears, which small card opens, and the words on it.
// Pure functions, so the components stay layout.

import type { AvatarRole } from "../avatar/blob";
import { cardSessionId, fileName, firstLine, toolName, type AgentCard } from "../runs";
import type { AgentEvent, PendingApproval, Preview, RunSummary, Settings, TaskKind, Tier } from "../types";

/** The collapsed island's face, most urgent first. "media" and "rest" only show when nothing is running. */
export type Moment = "needs" | "working" | "thinking" | "done" | "failed" | "media" | "rest";

/**
 * The key a finished card is remembered by once you have looked at it. A watched session can
 * finish many turns, so its key carries when the last one ended.
 */
export function seenKey(card: AgentCard): string {
  return card.run ? card.run.id : `${card.key}@${card.session?.lastActivity ?? ""}`;
}

/** A finished card that has not been looked at yet. A run you stopped yourself needs no news. */
export function isUnseenResult(card: AgentCard, seen: ReadonlySet<string>): boolean {
  if (card.active || card.run?.status === "cancelled") return false;
  if (card.state !== "done" && card.run?.status !== "failed") return false;
  return !seen.has(seenKey(card));
}

/**
 * The cards that may move the island off rest. Sessions you started yourself in a terminal only
 * count while they are working: their finished turns are not Mission Control's news, and "stalled"
 * is a guess you cannot answer from here. Those still show on the Desk.
 */
export function islandCards(cards: AgentCard[]): AgentCard[] {
  return cards.filter((c) => c.run || c.state === "working" || c.state === "thinking");
}

/**
 * What the island is about right now: the most urgent live agent, else the newest result you have
 * not looked at, else what is playing, else rest. `cards` arrive most urgent first.
 */
export function islandMoment(
  cards: AgentCard[],
  seen: ReadonlySet<string>,
  playing: boolean,
): { moment: Moment; card: AgentCard | null } {
  const live = cards.find((c) => c.active);
  if (live) {
    const moment = live.state === "needs" ? "needs" : live.state === "working" ? "working" : "thinking";
    return { moment, card: live };
  }
  const result = cards.find((c) => isUnseenResult(c, seen));
  if (result) return { moment: result.run?.status === "failed" ? "failed" : "done", card: result };
  return { moment: playing ? "media" : "rest", card: null };
}

/** The other live agents that ride along beside the lead, most urgent first. */
export function crewOf(cards: AgentCard[], lead: AgentCard | null, max = 3): AgentCard[] {
  return cards.filter((c) => c.active && c !== lead).slice(0, max);
}

// ---------- What an agent is doing ----------

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * A tool call as a short phrase: "Editing session.ts", "Running npm test", "Notion · search".
 * `short` keeps only a file's name, for the collapsed island.
 */
export function actionPhrase(tool: string, summary: string, short = false): { verb: string; object: string } {
  const object = short && !SHELL_TOOLS.has(tool) && /[\\/]/.test(summary) ? fileName(summary) : summary;
  if (EDIT_TOOLS.has(tool)) return { verb: "Editing", object };
  if (SHELL_TOOLS.has(tool)) return { verb: "Running", object };
  if (tool === "Read") return { verb: "Reading", object };
  if (tool === "Grep" || tool === "Glob") return { verb: "Searching", object };
  if (tool === "WebFetch" || tool === "WebSearch") return { verb: "Looking up", object };
  if (tool.startsWith("mcp__")) return { verb: toolName(tool), object };
  return { verb: tool, object };
}

/** What the lead agent is on: its latest tool call, or how it is starting. `feed` is newest first. */
export function currentAction(card: AgentCard, feed: AgentEvent[], short = false): { verb: string; object: string } {
  const run = card.run;
  if (run?.status === "starting" && run.decision.task === "assistant") return { verb: connectingLine(run.connections), object: "" };
  const id = cardSessionId(card);
  const call = id ? feed.find((e) => e.sessionId === id && e.kind.type === "toolCall") : undefined;
  if (call?.kind.type === "toolCall" && card.state === "working") return actionPhrase(call.kind.tool, call.kind.summary, short);
  if (card.state === "thinking") return { verb: "Thinking", object: "" };
  return { verb: card.line, object: "" };
}

/** "Connecting Gmail, Notion" while apps connect, or that it is about to start once they have. */
export function connectingLine(connections: { name: string; status: string }[]): string {
  const pending = connections.filter((c) => c.status === "pending").map((c) => c.name);
  if (connections.length === 0) return "Connecting to your apps";
  if (pending.length > 0) return `Connecting ${listNames(pending)}`;
  return "Apps ready, starting";
}

/** Apps that could not connect, which the run goes ahead without. */
export function connectingNote(connections: { name: string; status: string }[]): string | null {
  const left = connections.filter((c) => c.status !== "pending" && c.status !== "connected").map((c) => c.name);
  if (left.length === 0) return null;
  return `${listNames(left)} ${left.length === 1 ? "isn't" : "aren't"} connected; it goes ahead without`;
}

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

// ---------- Permission requests ----------

/** The app a tool belongs to, by its tool-name id: `mcp__claude_ai_Notion__x` is "claude_ai_Notion". */
export function appOfTool(tool: string): string | null {
  const match = tool.match(/^mcp__(.+?)__/);
  return match ? match[1] : null;
}

/** An app's tool-name id as a person would name it: "claude_ai_Notion" is "Notion". */
export function appName(appId: string): string {
  return appId.replace(/^claude_ai_/, "").replace(/_/g, " ");
}

/**
 * A request in plain words: a title such as "Run a command" or "Create pages in Notion", and the
 * one thing it acts on. `short` is the collapsed island's single line.
 */
export function requestWords(approval: PendingApproval): { title: string; detail: string; short: string; mono: boolean } {
  if (SHELL_TOOLS.has(approval.tool)) return { title: "Run a command", detail: approval.detail, short: approval.detail, mono: true };
  const app = appOfTool(approval.tool);
  if (app) {
    // The runtime labels app tools "Notion · create pages".
    const [name, action] = approval.label.includes(" · ") ? approval.label.split(" · ") : [appName(app), approval.label];
    const title = `${capitalise(action)} in ${name}`;
    return { title, detail: approval.detail, short: approval.label, mono: false };
  }
  if (EDIT_TOOLS.has(approval.tool)) return { title: "Edit a file", detail: approval.detail, short: `Edit ${fileName(approval.detail)}`, mono: true };
  return { title: `Use ${approval.label}`, detail: approval.detail, short: approval.label, mono: false };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The runtime never auto-approves a command that chains or redirects, so remembering one would do nothing.
const CHAINING = ["&&", "||", ";", "|", "`", "$(", ">", "<", "\n"];

/** What "Don't ask again" would remember for a request, or null when there is nothing it could. */
export type Remember = { kind: "app"; appId: string; label: string } | { kind: "command"; command: string; label: string };

export function rememberRule(approval: PendingApproval): Remember | null {
  const app = appOfTool(approval.tool);
  if (app) return { kind: "app", appId: app, label: `Don't ask again in ${appName(app)}` };
  if (SHELL_TOOLS.has(approval.tool)) {
    const command = approval.detail.trim();
    if (!command || CHAINING.some((c) => command.includes(c))) return null;
    return { kind: "command", command, label: "Don't ask again for this command" };
  }
  return null;
}

/** Settings with the rule added: the app may act on its own, or the command always runs. */
export function withRemembered(settings: Settings, rule: Remember): Settings {
  if (rule.kind === "app") return { ...settings, appAccess: { ...settings.appAccess, [rule.appId]: "act" } };
  if (settings.autoApprove.includes(rule.command)) return settings;
  return { ...settings, autoApprove: [...settings.autoApprove, rule.command] };
}

// ---------- Planning a goal ----------

const AGENT_LABEL: Record<TaskKind, string> = { code: "Coding", question: "Coding", browse: "Browser", assistant: "Assistant" };
const AGENT_ROLE: Record<TaskKind, AvatarRole> = { code: "code", question: "code", browse: "web", assistant: "assist" };
const TIER_LABEL: Record<Tier, string> = { fast: "Fast", balanced: "Balanced", strongest: "Strongest" };
const ACCESS_LABEL = { readOnly: "read only", editFiles: "edits files", useApps: "uses apps" } as const;

/** The plan line under the goal: "Coding · Balanced · edits files", with the agent's glyph. */
export function planLine(preview: Preview): { role: AvatarRole; text: string } {
  const { task, tier, access } = preview.decision;
  return { role: AGENT_ROLE[task], text: `${AGENT_LABEL[task]} · ${TIER_LABEL[tier]} · ${ACCESS_LABEL[access]}` };
}

// ---------- Results ----------

/** A finished answer as a title and one sentence after it. */
export function resultSummary(text: string | null): { title: string; summary: string | null } {
  const title = firstLine(text) ?? "Done";
  const lines = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/[*_`#>]/g, "").replace(/^[-\d.)\s]+/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("http"));
  const rest = lines.slice(1).join(" ");
  const sentence = rest.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? (rest || null);
  return { title, summary: sentence };
}

/** "3 min", "45 s", "1 h 20 min": how long a finished run took. */
export function took(startIso: string, endIso: string): string {
  const seconds = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** What the Boundaries rules answered on their own, from the counts the runtime keeps. */
export function ruleCounts(run: RunSummary): string[] {
  return [
    run.autoAllowed > 0 && `${run.autoAllowed} allowed by your rules`,
    run.autoDenied > 0 && `${run.autoDenied} blocked by your rules`,
  ].filter((s): s is string => typeof s === "string");
}

/** Why a run ended without a result, in a few words. */
export function failReason(run: RunSummary): string {
  if (run.status === "cancelled") return "You stopped it.";
  return run.exitCode !== null ? `It stopped with exit code ${run.exitCode}. The log has what happened.` : "It stopped early. The log has what happened.";
}

/**
 * Which Desk view Review opens: the changes for a code run allowed to edit files, else the run
 * itself, else today's work for sessions Mission Control only watches.
 */
export function reviewView(card: AgentCard): string {
  const run = card.run;
  if (!run) return "today";
  if (run.status === "finished" && run.decision.task === "code" && run.decision.access === "editFiles") return "changes";
  return `run:${run.id}`;
}

// ---------- Window sizing ----------

/** Room around the island inside its window, for the shadow. The island hangs from the top edge. */
export const WINDOW_PAD = { side: 20, bottom: 28 };

export type Size = { width: number; height: number };

/** The window size for an island of `island` size. */
export function windowFor(island: Size): Size {
  return { width: Math.ceil(island.width) + WINDOW_PAD.side * 2, height: Math.ceil(island.height) + WINDOW_PAD.bottom };
}

/**
 * Growing happens at once, before the island morphs, so nothing is clipped; shrinking waits until
 * the morph has finished. Returns the size to set now and, if smaller, the size to settle on later.
 */
export function resizeSteps(current: Size, target: Size): { now: Size | null; later: Size | null } {
  const grown = { width: Math.max(current.width, target.width), height: Math.max(current.height, target.height) };
  const now = grown.width !== current.width || grown.height !== current.height ? grown : null;
  const later = grown.width !== target.width || grown.height !== target.height ? target : null;
  return { now, later };
}

/** How far the eyes look toward a point, capped at `max` pixels each way. */
export function lookOffset(dx: number, dy: number, max = 1.5): { x: number; y: number } {
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return { x: 0, y: 0 };
  const reach = Math.min(1, distance / 120) * max;
  return { x: (dx / distance) * reach, y: (dy / distance) * reach };
}
