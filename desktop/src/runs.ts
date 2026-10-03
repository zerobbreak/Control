// How runs Mission Control started read in the pill. Pure functions, so the component stays layout.

import type { AvatarRole, AvatarState } from "./avatar/blob";
import type { PendingApproval, RunStatus, RunSummary, SessionSummary, TaskKind } from "./types";

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
    place: run.decision.task === "assistant" ? "your apps" : fileName(run.workdir),
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
