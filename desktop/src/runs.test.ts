import { describe, expect, it } from "vitest";
import {
  agentCards,
  agentName,
  elapsed,
  firstLine,
  firstLink,
  isActive,
  linkLabel,
  otherSessions,
  runHeadline,
  runRole,
  runState,
  statusCounts,
  visibleRuns,
} from "./runs";
import type { PendingApproval, RunStatus, RunSummary, SessionSummary, TaskKind } from "./types";

function run(id: string, status: RunStatus, task: TaskKind = "code", result: string | null = null): RunSummary {
  return {
    id,
    goal: "Create a Notion page for this assignment",
    workdir: "C:/Users/me/.mission-control/scratch",
    agent: "claude",
    model: "sonnet",
    decision: { task, tier: "balanced", access: task === "assistant" ? "useApps" : "editFiles", reason: "" },
    status,
    exitCode: null,
    startedAt: "2026-10-03T10:00:00Z",
    endedAt: null,
    logPath: "",
    result,
    autoAllowed: 0,
    autoDenied: 0,
  };
}

describe("run avatars", () => {
  it("gives the assistant its own role and maps each status to a mood", () => {
    expect(runRole(run("a", "running", "assistant"))).toBe("assist");
    expect(runRole(run("a", "running", "question"))).toBe("code");
    expect(runState(run("a", "starting"))).toBe("thinking");
    expect(runState(run("a", "needsApproval"))).toBe("needs");
    expect(runState(run("a", "finished"))).toBe("done");
  });

  it("names the assistant as the user knows it and says when it is connecting", () => {
    const assistant = run("a", "starting", "assistant");
    expect(agentName(assistant)).toBe("Assistant");
    expect(runHeadline(assistant)).toBe("Connecting to your apps…");
    expect(runHeadline(run("b", "starting"))).toBe("Starting…");
  });
});

describe("visibleRuns", () => {
  it("keeps every active run and the two newest finished ones", () => {
    const runs = [run("1", "finished"), run("2", "running"), run("3", "failed"), run("4", "cancelled"), run("5", "needsApproval")];
    expect(visibleRuns(runs).map((r) => r.id)).toEqual(["1", "2", "3", "5"]);
    expect(runs.filter(isActive).map((r) => r.id)).toEqual(["2", "5"]);
  });
});

describe("otherSessions", () => {
  it("drops sessions that are Mission Control's own runs", () => {
    const sessions = [{ sessionId: "mine" }, { sessionId: "theirs" }] as SessionSummary[];
    expect(otherSessions(sessions, [run("mine", "running")]).map((s) => s.sessionId)).toEqual(["theirs"]);
  });
});

describe("links in results", () => {
  it("finds the first link and drops trailing punctuation", () => {
    const text = "I created the page (https://app.notion.com/p/3eed786eea89?pvs=204). Tell me where to move it.";
    expect(firstLink(text)).toBe("https://app.notion.com/p/3eed786eea89?pvs=204");
    expect(firstLink("Saved to https://github.com/a/b/pull/12.")).toBe("https://github.com/a/b/pull/12");
    expect(firstLink("No link here")).toBeNull();
    expect(firstLink(null)).toBeNull();
  });

  it("names the app the link opens", () => {
    expect(linkLabel("https://www.notion.so/page-123")).toBe("Open in Notion");
    expect(linkLabel("https://app.notion.com/p/abc")).toBe("Open in Notion");
    expect(linkLabel("https://github.com/a/b/pull/1")).toBe("Open on GitHub");
    expect(linkLabel("https://example.com")).toBe("Open link");
    expect(linkLabel("not a url")).toBe("Open link");
  });
});

describe("agentCards", () => {
  const watched = { sessionId: "watched", agent: "claude", project: "C:/dev/Lumina", startedAt: "2026-10-03T09:00:00Z" } as SessionSummary;
  const view = () => ({ role: "code" as const, state: "working" as const, name: "Claude", line: "Edit · auth.rs" });
  const approval = { runId: "asking", requestId: "r1" } as PendingApproval;

  it("puts whoever needs you first, then working agents, then finished ones", () => {
    const runs = [run("done", "finished", "assistant", "**Created the page.**\nhttps://notion.so/x"), run("asking", "needsApproval", "assistant")];
    const cards = agentCards(runs, [watched], [approval], view);
    expect(cards.map((c) => c.key)).toEqual(["asking", "claude:watched", "done"]);
    expect(cards[0].approvals).toEqual([approval]);
    expect(cards[0].place).toBe("your apps");
    expect(cards[1].place).toBe("Lumina");
    expect(cards[2].line).toBe("Created the page.");
    expect(statusCounts(cards)).toEqual({ needs: 1, working: 1, done: 1 });
  });
});

describe("elapsed", () => {
  const start = "2026-10-03T10:00:00Z";
  const at = (seconds: number) => new Date(start).getTime() + seconds * 1000;
  it("counts seconds for short runs and rounds longer ones", () => {
    expect(elapsed(start, at(48))).toBe("0:48");
    expect(elapsed(start, at(125))).toBe("2:05");
    expect(elapsed(start, at(12 * 60))).toBe("12m");
    expect(elapsed(start, at(2 * 3600 + 10))).toBe("2h");
  });
});

describe("firstLine", () => {
  it("skips blank lines and markdown marks", () => {
    expect(firstLine("\n\n## I created the Notion page.\nMore")).toBe("I created the Notion page.");
    expect(firstLine(null)).toBeNull();
  });
});
