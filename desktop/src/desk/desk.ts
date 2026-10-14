// How the Desk reads the runtime's state. Pure functions, so the components stay layout.

import type { AvatarRole } from "../avatar/blob";
import { agentName, fileName, isActive, runRole, toolName } from "../runs";
import type {
  Access,
  AgentEvent,
  AppAccess,
  PendingApproval,
  RunStatus,
  RunSummary,
  SessionSummary,
  Settings,
  Tier,
} from "../types";

// ---------- Views ----------

export type DeskView =
  | { kind: "today" }
  | { kind: "changes" }
  | { kind: "boundaries" }
  /** One run; null opens the newest. */
  | { kind: "run"; runId: string | null };

/**
 * The view the pill asks for through open_dashboard: "today", "changes", "boundaries" or
 * "run:<id>". "activity" and "command" are the old names for Today and Boundaries.
 */
export function parseView(name: string): DeskView {
  if (name.startsWith("run:")) return { kind: "run", runId: name.slice(4) || null };
  switch (name) {
    case "runs":
      return { kind: "run", runId: null };
    case "changes":
      return { kind: "changes" };
    case "boundaries":
    case "command":
      return { kind: "boundaries" };
    default:
      return { kind: "today" };
  }
}

// ---------- Today's header ----------

export function greeting(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Tuesday 6 October". */
export function dayLabel(date: Date): string {
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function count(n: number): string {
  return n < NUMBERS.length ? NUMBERS[n] : String(n);
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The one line under the greeting: how many agents are at work, and what is waiting on you. */
export function statusLine(working: number, waiting: number): string {
  const work = working === 1 ? "one agent is at work" : `${count(working)} agents are at work`;
  const wait = waiting === 1 ? "one thing is waiting on you" : `${count(waiting)} things are waiting on you`;
  if (working === 0 && waiting === 0) return "Nothing is running. Give Mission Control a goal.";
  if (waiting === 0) return `${capital(work)}.`;
  if (working === 0) return `Nothing is running, but ${wait}.`;
  return `${capital(work)}, and ${wait}.`;
}

// ---------- Runs ----------

export function isSameDay(iso: string, now: number): boolean {
  const a = new Date(iso);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Runs that ended today, newest first. `runs` arrive newest first. */
export function doneToday(runs: RunSummary[], now: number): RunSummary[] {
  return runs.filter((r) => !isActive(r) && isSameDay(r.endedAt ?? r.startedAt, now));
}

export type Tone = "working" | "needs" | "done" | "failed" | "idle";

export function runStatusLabel(status: RunStatus): { label: string; tone: Tone } {
  switch (status) {
    case "starting":
      return { label: "Starting", tone: "working" };
    case "running":
      return { label: "Running", tone: "working" };
    case "needsApproval":
      return { label: "Needs you", tone: "needs" };
    case "finished":
      return { label: "Done", tone: "done" };
    case "failed":
      return { label: "Didn't finish", tone: "failed" };
    case "cancelled":
      return { label: "Stopped", tone: "idle" };
  }
}

/** The agent's kind, as the Desk names it: "Coding agent", "Assistant", "Browser agent". */
export function agentLabel(run: RunSummary): string {
  const name = agentName(run);
  return name === "Claude" ? "Coding agent" : name === "Browser" ? "Browser agent" : name;
}

export function tierLabel(tier: Tier): string {
  return { fast: "Fast", balanced: "Balanced", strongest: "Strongest" }[tier];
}

export function accessLabel(access: Access): string {
  return { readOnly: "Read only", editFiles: "May edit files", useApps: "Uses your apps" }[access];
}

/** "21:04", in local time. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "41 s", "2 min 41 s", "1 h 4 min". */
export function durationLabel(fromIso: string, to: number): string {
  const seconds = Math.max(0, Math.floor((to - new Date(fromIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

/** Every folder runs and watched sessions worked in, newest first, for the Changes view. */
export function workedFolders(runs: RunSummary[], sessions: SessionSummary[]): string[] {
  return [...new Set([...runs.map((r) => r.workdir), ...sessions.flatMap((s) => (s.project ? [s.project] : []))])];
}

// ---------- The board feed, for one run ----------

/** A run's events from the board, oldest first. The board sends its feed newest first. */
export function runEvents(feed: AgentEvent[], runId: string): AgentEvent[] {
  return feed.filter((e) => e.sessionId === runId).reverse();
}

/** How many tools a run has called that the board still remembers. */
export function actionCount(events: AgentEvent[]): number {
  return events.filter((e) => e.kind.type === "toolCall").length;
}

export type ToolKind = "read" | "edit" | "command" | "app" | "other";

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch"]);
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function toolKind(tool: string): ToolKind {
  if (READ_TOOLS.has(tool)) return "read";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (tool === "Bash" || tool === "PowerShell") return "command";
  if (tool.startsWith("mcp__")) return "app";
  return "other";
}

/** An app tool that only looks, such as "Notion · search", as opposed to one that makes or sends. */
function looksOnly(tool: string): boolean {
  return /(search|fetch|read|list|get|query|find|view)/i.test(tool.replace(/^mcp__.+?__/, ""));
}

export type Phase = { label: string; state: "done" | "now" | "needs" | "todo" };

/**
 * A run's progress as a few segments: started, looked around, made changes (unless it only
 * reads), finished. The runtime does not plan steps, so these are the stages every run passes
 * through, filled in from what the board has seen it do. `waiting` marks a request pending on
 * the user, which can arrive a moment before the run's status says so.
 */
export function runPhases(run: RunSummary, events: AgentEvent[], waiting = false): Phase[] {
  const calls = events.flatMap((e) => (e.kind.type === "toolCall" ? [e.kind.tool] : []));
  const changed = calls.some((t) => toolKind(t) === "edit" || (toolKind(t) === "app" && !looksOnly(t)));
  const stages: [string, boolean][] = [
    ["Started", run.status !== "starting"],
    ["Looked around", calls.length > 0 || run.status === "finished"],
    ...(run.decision.access === "readOnly" ? [] : ([["Made changes", changed || run.status === "finished"]] as [string, boolean][])),
    ["Finished", run.status === "finished"],
  ];
  let current = false;
  return stages.map(([label, reached]) => {
    if (reached) return { label, state: "done" };
    if (current || !isActive(run)) return { label, state: "todo" };
    current = true;
    return { label, state: waiting || run.status === "needsApproval" ? "needs" : "now" };
  });
}

/** What the run is on right now, for its card: the latest tool call or what it last said. */
export function currentAction(events: AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const { kind } = events[i];
    if (kind.type === "toolCall") return kind.summary ? `${toolName(kind.tool)} · ${kind.summary}` : toolName(kind.tool);
    if (kind.type === "assistantText") return kind.text.split("\n").find((l) => l.trim())?.trim() ?? null;
  }
  return null;
}

// ---------- The run's timeline ----------

export type ToolCallRow = { tool: string; summary: string; failed: boolean };

export type TimelineItem =
  | { type: "prompt"; at: string; text: string; first: boolean }
  | { type: "tools"; at: string; kind: ToolKind; calls: ToolCallRow[] }
  | { type: "text"; at: string; text: string }
  | { type: "error"; at: string; message: string };

/**
 * A run's events as a timeline: prompts, what the agent said, failures, and its tool calls
 * grouped while they are of one kind, so six reads read as one "Looked around".
 * Bookkeeping tools such as TodoWrite join whichever group they fall in.
 */
export function buildTimeline(events: AgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let prompts = 0;
  for (const event of events) {
    const { kind } = event;
    const last = items[items.length - 1];
    switch (kind.type) {
      case "userPrompt":
        items.push({ type: "prompt", at: event.timestamp, text: kind.text, first: prompts++ === 0 });
        break;
      case "assistantText":
        if (kind.text.trim()) items.push({ type: "text", at: event.timestamp, text: kind.text.trim() });
        break;
      case "toolCall": {
        const row = { tool: kind.tool, summary: kind.summary, failed: false };
        const toolType = toolKind(kind.tool);
        if (last?.type === "tools" && (last.kind === toolType || toolType === "other" || last.kind === "other")) {
          if (last.kind === "other") last.kind = toolType;
          last.calls.push(row);
        } else {
          items.push({ type: "tools", at: event.timestamp, kind: toolType, calls: [row] });
        }
        break;
      }
      case "toolResult":
        if (kind.isError && last?.type === "tools") last.calls[last.calls.length - 1].failed = true;
        break;
      case "error":
        items.push({ type: "error", at: event.timestamp, message: kind.message });
        break;
      case "title":
        break;
    }
  }
  return items;
}

/** The heading over a group of tool calls: "Looked around · 6 actions", "Changed 3 files". */
export function groupLabel(item: Extract<TimelineItem, { type: "tools" }>): string {
  const n = item.calls.length;
  const actions = `${n} action${n === 1 ? "" : "s"}`;
  const failed = item.calls.filter((c) => c.failed).length;
  const base = (() => {
    switch (item.kind) {
      case "read":
        return `Looked around · ${actions}`;
      case "edit": {
        const files = new Set(item.calls.filter((c) => toolKind(c.tool) === "edit").map((c) => c.summary)).size;
        return `Changed ${files} file${files === 1 ? "" : "s"}`;
      }
      case "command":
        return n === 1 ? "Ran a command" : `Ran ${n} commands`;
      case "app": {
        const app = toolName(item.calls[0].tool).split(" · ")[0];
        return `Used ${app} · ${actions}`;
      }
      default:
        return `Worked · ${actions}`;
    }
  })();
  return failed > 0 ? `${base} · ${failed} failed` : base;
}

/** "src/auth/session.ts" for a file inside the run's folder; other paths are left whole. */
export function relativePath(path: string, workdir: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = norm(path);
  const root = norm(workdir);
  return root && file.toLowerCase().startsWith(root.toLowerCase() + "/") ? file.slice(root.length + 1) : path;
}

/** Files the run has edited or written so far, as the board saw its tool calls, in order. */
export function changedFiles(events: AgentEvent[], workdir: string): string[] {
  const files = events.flatMap((e) =>
    e.kind.type === "toolCall" && EDIT_TOOLS.has(e.kind.tool) && e.kind.summary ? [relativePath(e.kind.summary, workdir)] : [],
  );
  return [...new Set(files)];
}

// ---------- Permission requests ----------

const CHAINING = ["&&", "||", ";", "|", "`", "$(", ">", "<", "\n"];

/**
 * What "Always allow" would add to the always-allow list for a shell command: its program and
 * subcommand, such as "npm install" for "npm install @auth/core". Null for anything that is not
 * a single plain command, which the runtime would never auto-approve anyway.
 */
export function alwaysAllowPrefix(tool: string, detail: string): string | null {
  if (tool !== "Bash" && tool !== "PowerShell") return null;
  const command = detail.trim();
  if (!command || CHAINING.some((c) => command.includes(c))) return null;
  const words = command.split(/\s+/);
  const sub = words[1] && /^[a-z][\w:-]*$/i.test(words[1]) ? words[1] : null;
  return sub ? `${words[0]} ${sub}` : words[0];
}

/** A request as one short line: "Run a command in Lumina", "Create pages in Notion". */
export function approvalTitle(approval: PendingApproval, place: string): string {
  if (approval.tool === "Bash" || approval.tool === "PowerShell") return `Run a command in ${place}`;
  if (approval.tool === "Edit" || approval.tool === "MultiEdit") return `Edit a file in ${place}`;
  if (approval.tool === "Write") return `Write a file in ${place}`;
  const [app, action] = approval.label.split(" · ");
  if (app && action) return `${capital(action)} in ${app}`;
  return `Use ${approval.label}`;
}

export function isCommand(tool: string): boolean {
  return tool === "Bash" || tool === "PowerShell";
}

// ---------- Settings, as the Limits and apps cards word them ----------

export function autonomyLabel(settings: Settings): string {
  if (settings.readOnlyMode) return "Read only";
  if (settings.fullAutonomy) return "Full";
  return settings.askBeforeEdits ? "Ask me" : "Edits on its own";
}

export function spendLabel(budget: number | null): string {
  return budget === null ? "No limit" : `up to $${budget.toFixed(2)}`;
}

export function appAccessLabel(access: AppAccess | undefined): string {
  // The runtime treats an app without a setting as "ask".
  return { read: "Read only", ask: "Asks first", act: "Acts on its own" }[access ?? "ask"];
}

// ---------- The sidebar's agents and watched sessions ----------

export type AgentRow = { role: AvatarRole; name: string; tone: Tone | "off" };

const TONE_RANK: Tone[] = ["idle", "done", "failed", "working", "needs"];

/** One row per agent Mission Control can start, lit by the most urgent of its active runs. */
export function agentRows(runs: RunSummary[], settings: Settings | null): AgentRow[] {
  const rows: { role: AvatarRole; name: string; off: boolean }[] = [
    { role: "code", name: "Coding", off: settings?.claudeEnabled === false },
    { role: "assist", name: "Assistant", off: settings?.assistantEnabled === false },
    { role: "web", name: "Browser", off: settings?.capabilities.browserControl === false },
  ];
  return rows.map(({ role, name, off }) => {
    const tones = runs.filter((r) => isActive(r) && runRole(r) === role).map((r) => runStatusLabel(r.status).tone);
    const tone = tones.reduce<Tone>((a, b) => (TONE_RANK.indexOf(b) > TONE_RANK.indexOf(a) ? b : a), "idle");
    return { role, name, tone: off && tone === "idle" ? "off" : tone };
  });
}

export function sessionTone(s: SessionSummary): Tone {
  return { working: "working", stalled: "needs", waitingForUser: "done", idle: "idle" }[s.status] as Tone;
}

export function sessionTitle(s: SessionSummary): string {
  const agent = s.agent === "claude" ? "Claude Code" : "Gemini CLI";
  return s.project ? `${agent} · ${fileName(s.project)}` : agent;
}

/** What a session in the user's own terminal is up to, in a sentence. */
export function watchedLine(s: SessionSummary, now: number): string {
  switch (s.status) {
    case "stalled": {
      const minutes = Math.max(1, Math.floor((now - new Date(s.lastActivity).getTime()) / 60_000));
      return `Quiet for ${minutes} min, probably waiting on a prompt in your terminal.`;
    }
    case "working":
      return s.currentActivity && s.currentActivity !== "Thinking" ? s.currentActivity : s.title ?? s.lastPrompt ?? "Working";
    case "waitingForUser":
      return s.lastMessage?.split("\n").find((l) => l.trim())?.trim() ?? "Finished its turn";
    case "idle":
      return `Idle since ${clockTime(s.lastActivity)}`;
  }
}
