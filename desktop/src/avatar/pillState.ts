import type { AgentKind, SessionSummary } from "../types";
import type { AvatarRole, AvatarState } from "./blob";

const URGENCY: AvatarState[] = ["idle", "done", "thinking", "working", "needs"];

/** What one agent session's avatar should show. */
export function sessionState(s: SessionSummary): AvatarState {
  switch (s.status) {
    // A turn that goes quiet without finishing is usually waiting on a permission prompt.
    case "stalled":
      return "needs";
    case "working":
      // The board reports "Thinking" between a prompt arriving and the first tool call.
      return !s.currentActivity || s.currentActivity === "Thinking" ? "thinking" : "working";
    case "waitingForUser":
      return "done";
    case "idle":
      return "idle";
  }
}

/** Mission Control's own mood: the most urgent state among its agents. */
export function leadState(sessions: SessionSummary[]): AvatarState {
  return mostUrgent(sessions.map(sessionState));
}

/** The most urgent of several states, or idle when there are none. */
export function mostUrgent(states: AvatarState[]): AvatarState {
  return states.reduce<AvatarState>((a, b) => (URGENCY.indexOf(b) > URGENCY.indexOf(a) ? b : a), "idle");
}

/** Which avatar an agent gets. Claude Code and Gemini CLI both work in a repo, so both are coding agents. */
export function roleOf(_agent: AgentKind): AvatarRole {
  return "code";
}

export const STATE_LABEL: Record<AvatarState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  needs: "Needs you",
  done: "Done",
};

/** Agents shown beside Mission Control in the collapsed pill, most urgent first. */
export function pillCrew(sessions: SessionSummary[], max = 3): SessionSummary[] {
  return sessions
    .filter((s) => s.status !== "idle")
    .map((s, i) => ({ s, i }))
    .sort((a, b) => URGENCY.indexOf(sessionState(b.s)) - URGENCY.indexOf(sessionState(a.s)) || a.i - b.i)
    .slice(0, max)
    .map(({ s }) => s);
}

export type StepStatus = "done" | "current" | "blocked" | "upcoming";
export type ProgressStep = { label: string; status: StepStatus };

/**
 * Where a session is in its turn: Thinking → Working → Done.
 * A stalled turn is stuck on the Working step until you step in, so that step reads "Needs you".
 */
export function progressSteps(state: AvatarState): ProgressStep[] {
  const reached = { idle: -1, thinking: 0, working: 1, needs: 1, done: 3 }[state];
  return ["Thinking", "Working", "Done"].map((label, i) => {
    if (i < reached) return { label, status: "done" };
    if (i > reached) return { label, status: "upcoming" };
    return state === "needs" ? { label: "Needs you", status: "blocked" } : { label, status: "current" };
  });
}
