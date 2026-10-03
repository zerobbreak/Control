// How runs Mission Control started read in the pill. Pure functions, so the component stays layout.

import type { AvatarRole, AvatarState } from "./avatar/blob";
import { roleOf, sessionState } from "./avatar/pillState";
import type { AgentEvent, PendingApproval, RunStatus, RunSummary, SessionSummary, TaskKind } from "./types";

const ROLE: Record<TaskKind, AvatarRole> = {
  code: "code",
  question: "code",
  browse: "web",
  assistant: "assist",
};

const STATE: Record<RunStatus, AvatarState> = {
  starting: "thinking",
  running: "working",
  needsApproval: "needs",
  finished: "done",
  failed: "idle",
  cancelled: "idle",
};

/** Runs this many finished runs stay in the pill after they end, newest first. */
const RECENT_FINISHED = 2;

export function runRole(run: RunSummary): AvatarRole {
  return ROLE[run.decision.task];
}

export function runState(run: RunSummary): AvatarState {
  return STATE[run.status];
}

export function isActive(run: RunSummary): boolean {
  return run.status === "starting" || run.status === "running" || run.status === "needsApproval";
}

/** Who is doing the work, as the user thinks of it: the assistant is not "Claude Code". */
export function agentName(run: RunSummary): string {
  switch (run.decision.task) {
    case "assistant":
      return "Assistant";
    case "browse":
      return "Browser";
    default:
      return "Claude";
  }
}

export function runHeadline(run: RunSummary): string {
  switch (run.status) {
    case "starting":
      return run.decision.task === "assistant" ? "Connecting to your apps…" : "Starting…";
    case "running":
      return "Working";
    case "needsApproval":
      return "Needs you";
    case "finished":
      return "Done";
    case "failed":
      return "Didn't finish";
    case "cancelled":
      return "Cancelled";
  }
}

/** Where a run works, as a chip: the folder it looks through, the browser, the user's apps or its project. */
export function runPlace(run: RunSummary): string {
  if (run.decision.task === "browse") return "Chrome";
  if (run.decision.task === "assistant") {
    // A read-only look at a dropped folder happens in that folder, not in the user's apps.
    const folder = run.decision.access === "readOnly" ? run.attachments?.find((a) => !/\.[^\\/]+$/.test(a)) : undefined;
    return folder ? fileName(folder) : "your apps";
  }
  return fileName(run.workdir);
}

/** Every active run, plus the most recent finished ones. `runs` arrive newest first. */
export function visibleRuns(runs: RunSummary[]): RunSummary[] {
  const finished = runs.filter((r) => !isActive(r)).slice(0, RECENT_FINISHED);
  return runs.filter((r) => isActive(r) || finished.includes(r));
}

/** Sessions that are not one of Mission Control's own runs, so nothing shows twice. */
export function otherSessions(sessions: SessionSummary[], runs: RunSummary[]): SessionSummary[] {
  const own = new Set(runs.map((r) => r.id));
  return sessions.filter((s) => !own.has(s.sessionId));
}

/** The first web link in an agent's answer, e.g. the Notion page it created. */
export function firstLink(text: string | null): string | null {
  const match = text?.match(/https?:\/\/[^\s<>"'`)\]]+/);
  return match ? match[0].replace(/[.,;:!?]+$/, "") : null;
}

export function linkLabel(url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (/(^|\.)notion\.(so|com)$/.test(host)) return "Open in Notion";
  if (/(^|\.)github\.com$/.test(host)) return "Open on GitHub";
  if (host === "mail.google.com") return "Open in Gmail";
  if (host === "calendar.google.com") return "Open in Calendar";
  return "Open link";
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

// ---------- Design B: one stack of agent cards, most urgent first ----------

/** One agent in the stack: a run Mission Control started, or a session it watches. */
export type AgentCard = {
  key: string;
  role: AvatarRole;
  state: AvatarState;
  name: string;
  /** Where it works, shown as a chip: a project folder, or "your apps" for the assistant. */
  place: string;
  /** What it is doing, or how it ended. */
  line: string;
  /** When its current stretch of work began, for the elapsed time. */
  since: string;
  active: boolean;
  run?: RunSummary;
  session?: SessionSummary;
  /** Permission requests waiting on this agent, oldest first. */
  approvals: PendingApproval[];
};

const URGENCY: AvatarState[] = ["idle", "done", "thinking", "working", "needs"];

export function agentCards(
  runs: RunSummary[],
  sessions: SessionSummary[],
  approvals: PendingApproval[],
  sessionView: (s: SessionSummary) => { role: AvatarRole; state: AvatarState; name: string; line: string },
): AgentCard[] {
  const fromRuns: AgentCard[] = visibleRuns(runs).map((run) => ({
    key: run.id,
    role: runRole(run),
    state: runState(run),
    name: agentName(run),
    place: runPlace(run),
    line: run.status === "finished" ? firstLine(run.result) ?? "Done" : runHeadline(run),
    since: run.startedAt,
    active: isActive(run),
    run,
    approvals: approvals.filter((a) => a.runId === run.id),
  }));
  const fromSessions: AgentCard[] = otherSessions(sessions, runs).map((session) => {
    const view = sessionView(session);
    return {
      key: `${session.agent}:${session.sessionId}`,
      ...view,
      place: session.project ? fileName(session.project) : "",
      since: session.startedAt,
      active: view.state !== "done" && view.state !== "idle",
      session,
      approvals: [],
    };
  });
  return [...fromRuns, ...fromSessions]
    .map((card, i) => ({ card, i }))
    .sort((a, b) => URGENCY.indexOf(b.card.state) - URGENCY.indexOf(a.card.state) || a.i - b.i)
    .map(({ card }) => card);
}

/** Keep the pill focused on live work and a small, fresh sample of completed work. */
export function pillCards(cards: AgentCard[], now: number, recentMinutes = 30, maxCompleted = 2): AgentCard[] {
  const completed = cards
    .filter((card) => !card.active)
    .filter((card) => {
      const ended = card.run?.endedAt ?? card.session?.lastActivity;
      if (!ended) return false;
      const age = now - new Date(ended).getTime();
      return age >= 0 && age <= recentMinutes * 60_000;
    })
    .sort((a, b) => {
      const aTime = a.run?.endedAt ?? a.session?.lastActivity ?? "";
      const bTime = b.run?.endedAt ?? b.session?.lastActivity ?? "";
      return bTime.localeCompare(aTime);
    })
    .slice(0, maxCompleted);
  const keep = new Set(completed.map((card) => card.key));
  return cards.filter((card) => card.active || keep.has(card.key));
}

/** The counts shown as chips under the header. */
export function statusCounts(cards: AgentCard[]) {
  return {
    needs: cards.filter((c) => c.state === "needs").length,
    working: cards.filter((c) => c.state === "working" || c.state === "thinking").length,
    done: cards.filter((c) => c.state === "done").length,
  };
}

/** "0:48" while it is short, "12m" or "2h" after that. */
export function elapsed(sinceIso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(sinceIso).getTime()) / 1000));
  if (seconds < 600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/** The first meaningful line of an agent's answer, for a one-line card. */
export function firstLine(text: string | null): string | null {
  const line = text
    ?.split("\n")
    .map((l) => l.replace(/[*_`#>]/g, "").trim())
    .find((l) => l.length > 0);
  return line ?? null;
}

// ---------- Agent detail: what one agent has been doing ----------

/** One tool call in an agent's activity log. */
export type ActivityRow = {
  at: string;
  tool: string;
  summary: string;
  failed: boolean;
};

/** The board session an agent card follows. A run's id is also its session id. */
export function cardSessionId(card: AgentCard): string | undefined {
  return card.run?.id ?? card.session?.sessionId;
}

/**
 * An agent's most recent tool calls, oldest first, each marked failed when its result was an error.
 * `feed` arrives newest first, as the board sends it.
 */
export function agentActivity(feed: AgentEvent[], sessionId: string | undefined, limit = 6): ActivityRow[] {
  if (!sessionId) return [];
  const rows: ActivityRow[] = [];
  for (const event of [...feed].reverse()) {
    if (event.sessionId !== sessionId) continue;
    if (event.kind.type === "toolCall") {
      rows.push({ at: event.timestamp, tool: toolName(event.kind.tool), summary: event.kind.summary, failed: false });
    } else if (event.kind.type === "toolResult" && event.kind.isError && rows.length > 0) {
      rows[rows.length - 1].failed = true;
    }
  }
  return rows.slice(-limit);
}

/** "now" for the last minute, then how long ago in the same style as `elapsed`. */
export function ago(iso: string, now: number): string {
  return now - new Date(iso).getTime() < 60_000 ? "now" : elapsed(iso, now);
}

/** The mono line under an agent's name: where, for how long, and how much it has done. */
export function detailMeta(card: AgentCard, now: number, tools: number, failed: number): string {
  const ended = card.run?.endedAt;
  const time = ended ? `finished ${roughlyAgo(ended, now)}` : elapsed(card.since, now);
  return [card.place, time, tools > 0 && `${tools} tools`, failed > 0 && `${failed} failed`].filter(Boolean).join(" · ");
}

/** "just now", "6m ago", "2h ago": for things that are over, where seconds don't matter. */
export function roughlyAgo(iso: string, now: number): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * The tool call a session is held on: its last call, when no result has come back for it yet.
 * For a session in someone's own terminal this is what its permission prompt is asking about.
 */
export function unansweredCall(feed: AgentEvent[], sessionId: string | undefined): ActivityRow | null {
  if (!sessionId) return null;
  const latest = feed.find((e) => e.sessionId === sessionId && (e.kind.type === "toolCall" || e.kind.type === "toolResult"));
  if (latest?.kind.type !== "toolCall") return null;
  return { at: latest.timestamp, tool: latest.kind.tool, summary: latest.kind.summary, failed: false };
}

/** How a permission request opens, in the design's words: "Wants to run" for shell commands. */
export function requestVerb(tool: string, label: string): string {
  return tool === "Bash" || tool === "PowerShell" ? "Wants to run" : `Wants to use ${label}`;
}

/**
 * The short line on a grid tile: what the agent did, what it is doing now, or what it wants from you.
 * `feed` arrives newest first, as the board sends it.
 */
export function tileLine(card: AgentCard, feed: AgentEvent[]): string {
  const request = card.approvals[0];
  if (request) return `${requestVerb(request.tool, request.label)} ${request.detail}`;
  if (card.state === "needs") {
    const held = unansweredCall(feed, cardSessionId(card));
    return held ? `Waiting in its terminal: ${held.summary}` : "Waiting on you in its own terminal";
  }
  const run = card.run;
  if (run?.status === "failed") return "Didn't finish. Open it to see the log.";
  if (run?.status === "cancelled") return "You stopped it.";
  if (card.state === "done") return card.line;
  const latest = agentActivity(feed, cardSessionId(card), 1)[0];
  if (latest) return `${latest.tool} · ${latest.summary}`;
  return run?.goal ?? card.line;
}

/**
 * What a finished app errand made, from the link in its answer: "Page created in Notion", and
 * where it went. Null for links that are not to one of the user's apps.
 */
export function resultHeadline(url: string, notionParent: string | null): { title: string; note: string } | null {
  switch (linkLabel(url)) {
    case "Open in Notion":
      return {
        title: "Page created in Notion",
        note: notionParent ? `Under ${notionParent}` : "Private draft · tell the assistant where it should live",
      };
    case "Open in Gmail":
      return { title: "Ready in Gmail", note: "Nothing is sent until you send it" };
    case "Open in Calendar":
      return { title: "Added to your calendar", note: "Open it to check the details" };
    case "Open on GitHub":
      return { title: "Done on GitHub", note: "Open it to review" };
    default:
      return null;
  }
}

/** The connection states Claude Code reports, as the pill words them. */
export function connectionLabel(status: string): { label: string; tone: "done" | "working" | "idle" | "error"; note?: string } {
  switch (status) {
    case "connected":
      return { label: "Connected", tone: "done" };
    case "pending":
      return { label: "Connecting…", tone: "working" };
    case "needs-auth":
      return { label: "Needs sign-in", tone: "idle", note: "won't hold this up" };
    default:
      return { label: "Couldn't connect", tone: "error", note: "won't hold this up" };
  }
}

/** How a watched session reads as a card, in the pill and on the dashboard alike. */
export function sessionView(s: SessionSummary) {
  return {
    role: roleOf(s.agent),
    state: sessionState(s),
    name: s.agent === "claude" ? "Claude" : "Gemini",
    line: activityText(s),
  };
}

/** What the agent is on right now. "Thinking" is already the card's state, so show the prompt instead. */
export function activityText(s: SessionSummary) {
  const activity = s.currentActivity === "Thinking" ? null : s.currentActivity;
  return activity ?? s.title ?? s.lastPrompt ?? "Waiting";
}

/**
 * A tool as a person would name it: `mcp__claude_ai_Notion__notion-search` reads as
 * "Notion · search", the way the runtime words approvals. Built-in tools keep their names.
 */
export function toolName(tool: string): string {
  const match = tool.match(/^mcp__(.+?)__(.+)$/);
  if (!match) return tool;
  const app = match[1].replace(/^claude_ai_/, "").replace(/_/g, " ");
  const action = match[2].replace(new RegExp(`^${app.split(" ")[0]}[-_]`, "i"), "").replace(/[-_]/g, " ");
  return `${app} · ${action}`;
}
