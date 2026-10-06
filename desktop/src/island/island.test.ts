import { describe, expect, it } from "vitest";
import { agentCards, sessionView } from "../runs";
import type { AgentEvent, PendingApproval, Preview, RunStatus, RunSummary, SessionSummary, Settings, TaskKind } from "../types";
import {
  actionPhrase,
  appOfTool,
  connectingLine,
  connectingNote,
  crewOf,
  currentAction,
  failReason,
  islandCards,
  islandMoment,
  lookOffset,
  planLine,
  rememberRule,
  requestWords,
  resizeSteps,
  resultSummary,
  reviewView,
  ruleCounts,
  seenKey,
  took,
  windowFor,
  withRemembered,
} from "./island";

function run(id: string, status: RunStatus, task: TaskKind = "code", result: string | null = null): RunSummary {
  return {
    id,
    goal: "Fix the login",
    workdir: "C:/code/Lumina",
    agent: "claude",
    model: "sonnet",
    decision: { task, tier: "balanced", access: task === "assistant" ? "useApps" : "editFiles", reason: "" },
    status,
    exitCode: null,
    startedAt: "2026-10-03T10:00:00Z",
    endedAt: status === "finished" || status === "failed" || status === "cancelled" ? "2026-10-03T10:03:00Z" : null,
    logPath: "",
    attachments: [],
    connections: [],
    result,
    autoAllowed: 0,
    autoDenied: 0,
  };
}

function approval(tool: string, label: string, detail: string, runId = "r1"): PendingApproval {
  return { runId, agent: "claude", workdir: "C:/code/Lumina", requestId: "q1", tool, label, detail, description: null, askedAt: "2026-10-03T10:01:00Z" };
}

function session(id: string, status: SessionSummary["status"]): SessionSummary {
  return {
    agent: "claude",
    sessionId: id,
    project: "C:/code/Other",
    title: null,
    status,
    startedAt: "2026-10-03T09:00:00Z",
    lastActivity: "2026-10-03T09:30:00Z",
    lastPrompt: "tidy up",
    currentActivity: "Reading",
    lastMessage: "All tidy.",
    toolCalls: 3,
    toolErrors: 0,
  };
}

function cards(runs: RunSummary[], approvals: PendingApproval[] = [], sessions: SessionSummary[] = []) {
  return agentCards(runs, sessions, approvals, sessionView);
}

const settings = { appAccess: {}, autoApprove: ["npm test"] } as unknown as Settings;

describe("islandMoment", () => {
  it("rests with nothing going on, or shows what is playing", () => {
    expect(islandMoment([], new Set(), false)).toEqual({ moment: "rest", card: null });
    expect(islandMoment([], new Set(), true).moment).toBe("media");
  });

  it("follows the most urgent live agent over results and media", () => {
    const all = cards([run("a", "running"), run("b", "needsApproval"), run("c", "finished", "code", "Done")]);
    const { moment, card } = islandMoment(all, new Set(), true);
    expect(moment).toBe("needs");
    expect(card?.key).toBe("b");
    expect(islandMoment(cards([run("a", "starting")]), new Set(), false).moment).toBe("thinking");
    expect(islandMoment(cards([run("a", "running")]), new Set(), false).moment).toBe("working");
  });

  it("shows a result until it has been seen, then settles", () => {
    const all = cards([run("a", "finished", "code", "Login works again")]);
    expect(islandMoment(all, new Set(), false).moment).toBe("done");
    expect(islandMoment(all, new Set([seenKey(all[0])]), false).moment).toBe("rest");
  });

  it("reports a failed run but not one you stopped yourself", () => {
    expect(islandMoment(cards([run("a", "failed")]), new Set(), false).moment).toBe("failed");
    expect(islandMoment(cards([run("a", "cancelled")]), new Set(), false).moment).toBe("rest");
  });

  it("keys a watched session's result by its last turn", () => {
    const [card] = cards([], [], [session("s", "waitingForUser")]);
    expect(seenKey(card)).toBe("claude:s@2026-10-03T09:30:00Z");
  });
});

describe("islandCards", () => {
  it("rests when only your own terminal sessions finished a turn or went quiet", () => {
    const all = islandCards(cards([], [], [session("s", "waitingForUser"), session("t", "stalled")]));
    expect(islandMoment(all, new Set(), false)).toEqual({ moment: "rest", card: null });
  });

  it("still shows a terminal session that is working", () => {
    const all = islandCards(cards([], [], [session("s", "working")]));
    expect(islandMoment(all, new Set(), false).moment).toBe("working");
  });

  it("keeps Mission Control's own runs, finished ones included", () => {
    const all = islandCards(cards([run("a", "finished", "code", "Fixed")], [], [session("s", "waitingForUser")]));
    expect(all.map((c) => c.key)).toEqual(["a"]);
  });
});

describe("crewOf", () => {
  it("lists other live agents beside the lead", () => {
    const all = cards([run("a", "running"), run("b", "needsApproval"), run("c", "finished", "code", "x")]);
    const lead = islandMoment(all, new Set(), false).card;
    expect(crewOf(all, lead).map((c) => c.key)).toEqual(["a"]);
  });
});

describe("what an agent is doing", () => {
  it("words tool calls as actions, shortening paths for the collapsed island", () => {
    expect(actionPhrase("Edit", "src/auth/session.ts")).toEqual({ verb: "Editing", object: "src/auth/session.ts" });
    expect(actionPhrase("Edit", "src/auth/session.ts", true)).toEqual({ verb: "Editing", object: "session.ts" });
    expect(actionPhrase("Bash", "npm run build/all", true)).toEqual({ verb: "Running", object: "npm run build/all" });
    expect(actionPhrase("mcp__claude_ai_Notion__notion-search", "INSY")).toEqual({ verb: "Notion · search", object: "INSY" });
  });

  it("reads the lead's latest tool call from the feed", () => {
    const feed: AgentEvent[] = [
      { agent: "claude", sessionId: "a", project: null, timestamp: "2026-10-03T10:02:00Z", kind: { type: "toolCall", tool: "Write", summary: "C:/code/Lumina/a.ts" } },
    ];
    const [card] = cards([run("a", "running")]);
    expect(currentAction(card, feed, true)).toEqual({ verb: "Editing", object: "a.ts" });
  });

  it("says which apps are still connecting while the assistant starts", () => {
    const connections = [
      { name: "Gmail", status: "pending" },
      { name: "Notion", status: "pending" },
      { name: "Drive", status: "needs-auth" },
    ];
    expect(connectingLine(connections)).toBe("Connecting Gmail, Notion");
    expect(connectingLine([])).toBe("Connecting to your apps");
    expect(connectingNote(connections)).toBe("Drive isn't connected; it goes ahead without");
    expect(connectingNote([{ name: "Gmail", status: "connected" }])).toBeNull();
  });
});

describe("permission requests", () => {
  it("finds the app a tool belongs to", () => {
    expect(appOfTool("mcp__claude_ai_Notion__notion-create-pages")).toBe("claude_ai_Notion");
    expect(appOfTool("Bash")).toBeNull();
  });

  it("puts a request in plain words", () => {
    expect(requestWords(approval("mcp__claude_ai_Notion__notion-create-pages", "Notion · create pages", "Project brief"))).toMatchObject({
      title: "Create pages in Notion",
      detail: "Project brief",
      short: "Notion · create pages",
    });
    expect(requestWords(approval("Bash", "Bash", "npm install @auth/core"))).toMatchObject({ title: "Run a command", short: "npm install @auth/core", mono: true });
  });

  it("remembers an app's tools as act and a plain command as always allowed", () => {
    const app = rememberRule(approval("mcp__claude_ai_Notion__notion-create-pages", "Notion · create pages", "x"));
    expect(app).toEqual({ kind: "app", appId: "claude_ai_Notion", label: "Don't ask again in Notion" });
    expect(withRemembered(settings, app!).appAccess).toEqual({ claude_ai_Notion: "act" });

    const command = rememberRule(approval("Bash", "Bash", " npm install "));
    expect(command).toMatchObject({ kind: "command", command: "npm install" });
    expect(withRemembered(settings, command!).autoApprove).toEqual(["npm test", "npm install"]);
    expect(withRemembered(settings, { kind: "command", command: "npm test", label: "" })).toBe(settings);
  });

  it("offers nothing to remember where the runtime could not use it", () => {
    expect(rememberRule(approval("Bash", "Bash", "npm test && rm -rf dist"))).toBeNull();
    expect(rememberRule(approval("Edit", "Edit", "a.ts"))).toBeNull();
  });
});

describe("planLine", () => {
  it("says who will do the goal, how strong a model and with what access", () => {
    const preview = { decision: { task: "code", tier: "balanced", access: "editFiles", reason: "" } } as Preview;
    expect(planLine(preview)).toEqual({ role: "code", text: "Coding · Balanced · edits files" });
  });
});

describe("results", () => {
  it("takes a title and one sentence from the answer", () => {
    const text = "**Login works again**\n\nThe session cookie was dropped on redirect. Fixed in the middleware.\n- a.ts";
    expect(resultSummary(text)).toEqual({ title: "Login works again", summary: "The session cookie was dropped on redirect." });
    expect(resultSummary(null)).toEqual({ title: "Done", summary: null });
    expect(resultSummary("Just one line")).toEqual({ title: "Just one line", summary: null });
  });

  it("says how long a run took", () => {
    expect(took("2026-10-03T10:00:00Z", "2026-10-03T10:00:45Z")).toBe("45 s");
    expect(took("2026-10-03T10:00:00Z", "2026-10-03T10:03:00Z")).toBe("3 min");
    expect(took("2026-10-03T10:00:00Z", "2026-10-03T11:20:00Z")).toBe("1 h 20 min");
  });

  it("counts only what the rules actually answered", () => {
    expect(ruleCounts(run("a", "finished"))).toEqual([]);
    expect(ruleCounts({ ...run("a", "finished"), autoAllowed: 9, autoDenied: 1 })).toEqual(["9 allowed by your rules", "1 blocked by your rules"]);
  });

  it("explains why a run ended early", () => {
    expect(failReason(run("a", "cancelled"))).toBe("You stopped it.");
    expect(failReason({ ...run("a", "failed"), exitCode: 2 })).toContain("exit code 2");
  });

  it("opens changes for code that edited files, else the run, else today", () => {
    const [code] = cards([run("a", "finished", "code", "x")]);
    const [assistant] = cards([run("b", "finished", "assistant", "x")]);
    const [watched] = cards([], [], [session("s", "waitingForUser")]);
    expect(reviewView(code)).toBe("changes");
    expect(reviewView(assistant)).toBe("run:b");
    expect(reviewView(watched)).toBe("today");
  });
});

describe("window sizing", () => {
  it("leaves room for the shadow around the island", () => {
    expect(windowFor({ width: 360, height: 150.4 })).toEqual({ width: 400, height: 179 });
  });

  it("grows at once and shrinks after the morph", () => {
    expect(resizeSteps({ width: 100, height: 60 }, { width: 400, height: 200 })).toEqual({ now: { width: 400, height: 200 }, later: null });
    expect(resizeSteps({ width: 400, height: 200 }, { width: 100, height: 60 })).toEqual({ now: null, later: { width: 100, height: 60 } });
    expect(resizeSteps({ width: 400, height: 60 }, { width: 100, height: 200 })).toEqual({
      now: { width: 400, height: 200 },
      later: { width: 100, height: 200 },
    });
    expect(resizeSteps({ width: 100, height: 60 }, { width: 100, height: 60 })).toEqual({ now: null, later: null });
  });

  it("turns the eyes a little toward the cursor", () => {
    expect(lookOffset(0, 0)).toEqual({ x: 0, y: 0 });
    expect(lookOffset(1000, 0)).toEqual({ x: 1.5, y: 0 });
    expect(lookOffset(60, 0).x).toBeCloseTo(0.75);
  });
});
