import { describe, expect, it } from "vitest";
import type { SessionStatus, SessionSummary } from "../types";
import { leadState, pillCrew, progressSteps, roleOf, sessionState } from "./pillState";

function session(id: string, status: SessionStatus, currentActivity: string | null = null): SessionSummary {
  return {
    agent: "claude",
    sessionId: id,
    project: "C:/dev/lumina",
    title: null,
    status,
    startedAt: "2026-10-02T10:00:00Z",
    lastActivity: "2026-10-02T10:05:00Z",
    lastPrompt: "Fix the login page",
    currentActivity,
    lastMessage: null,
    toolCalls: 0,
    toolErrors: 0,
  };
}

describe("sessionState", () => {
  it.each([
    ["stalled", null, "needs"],
    ["working", "Thinking", "thinking"],
    ["working", null, "thinking"],
    ["working", "Edit · auth/session.rs", "working"],
    ["working", "Bash · Run tests", "working"],
    ["waitingForUser", null, "done"],
    ["idle", null, "idle"],
  ] as const)("%s with activity %s shows %s", (status, activity, expected) => {
    expect(sessionState(session("s", status, activity))).toBe(expected);
  });
});

describe("leadState", () => {
  it("is idle with no agents", () => {
    expect(leadState([])).toBe("idle");
  });

  it("shows the most urgent agent", () => {
    const working = session("a", "working", "Edit · a.rs");
    const done = session("b", "waitingForUser");
    const stalled = session("c", "stalled");
    expect(leadState([done, working])).toBe("working");
    expect(leadState([done, working, stalled])).toBe("needs");
    expect(leadState([done])).toBe("done");
    expect(leadState([session("d", "working", "Thinking"), done])).toBe("thinking");
  });
});

describe("pillCrew", () => {
  it("leaves idle agents out of the pill", () => {
    expect(pillCrew([session("a", "idle"), session("b", "working", "Edit · x")]).map((s) => s.sessionId)).toEqual(["b"]);
  });

  it("puts the most urgent agents first and keeps at most three", () => {
    const crew = pillCrew([
      session("done", "waitingForUser"),
      session("think", "working", "Thinking"),
      session("stuck", "stalled"),
      session("edit", "working", "Edit · x"),
    ]);
    expect(crew.map((s) => s.sessionId)).toEqual(["stuck", "edit", "think"]);
  });

  it("keeps the board's order between agents in the same state", () => {
    const crew = pillCrew([session("first", "working", "Edit · a"), session("second", "working", "Edit · b")]);
    expect(crew.map((s) => s.sessionId)).toEqual(["first", "second"]);
  });
});

describe("roleOf", () => {
  it("treats Claude Code and Gemini CLI as coding agents", () => {
    expect(roleOf("claude")).toBe("code");
    expect(roleOf("gemini")).toBe("code");
  });
});

describe("progressSteps", () => {
  const statuses = (state: Parameters<typeof progressSteps>[0]) => progressSteps(state).map((s) => s.status);

  it("walks Thinking → Working → Done", () => {
    expect(statuses("idle")).toEqual(["upcoming", "upcoming", "upcoming"]);
    expect(statuses("thinking")).toEqual(["current", "upcoming", "upcoming"]);
    expect(statuses("working")).toEqual(["done", "current", "upcoming"]);
    expect(statuses("done")).toEqual(["done", "done", "done"]);
  });

  it("blocks the Working step when the agent needs you", () => {
    expect(progressSteps("needs")).toEqual([
      { label: "Thinking", status: "done" },
      { label: "Needs you", status: "blocked" },
      { label: "Done", status: "upcoming" },
    ]);
  });
});
