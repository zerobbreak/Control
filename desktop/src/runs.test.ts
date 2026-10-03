import { describe, expect, it } from "vitest";
import {
  agentActivity,
  agentCards,
  ago,
  detailMeta,
  agentName,
  elapsed,
  firstLine,
  firstLink,
  isActive,
  linkLabel,
  otherSessions,
  pillCards,
  requestVerb,
  tileLine,
  unansweredCall,
  runHeadline,
  runPlace,
  resultHeadline,
  toolName,
  connectionLabel,
  runRole,
  runState,
  statusCounts,
  visibleRuns,
} from "./runs";
import type { AgentEvent, EventKind, PendingApproval, RunStatus, RunSummary, SessionSummary, TaskKind } from "./types";

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
    attachments: [],
    connections: [],
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

describe("runPlace", () => {
  it("names where each kind of run works", () => {
    expect(runPlace(run("a", "running", "browse"))).toBe("Chrome");
    expect(runPlace(run("a", "running", "assistant"))).toBe("your apps");
    const folderLook = { ...run("a", "finished", "assistant"), attachments: ["C:/Users/me/Downloads"] };
    folderLook.decision = { ...folderLook.decision, access: "readOnly" as const };
    expect(runPlace(folderLook)).toBe("Downloads");
    expect(runPlace(run("a", "running"))).toBe("scratch");
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

describe("pillCards", () => {
  it("keeps live sessions and only the two newest recent completions", () => {
    const now = new Date("2026-10-03T11:00:00Z").getTime();
    const active = { ...run("active", "running") };
    const finished = (id: string, endedAt: string) => ({ ...run(id, "finished"), endedAt });
    const runs = [finished("recent-1", "2026-10-03T10:59:00Z"), active, finished("recent-2", "2026-10-03T10:58:00Z")];
    const session = (id: string, status: SessionSummary["status"], lastActivity: string) => ({
      sessionId: id, agent: "claude" as const, status, lastActivity, startedAt: lastActivity, project: null,
    }) as SessionSummary;
    const watched = [
      session("working", "working", "2026-10-03T10:30:00Z"),
      session("done", "waitingForUser", "2026-10-03T10:57:00Z"),
      session("old", "waitingForUser", "2026-10-03T10:20:00Z"),
    ];
    const cards = agentCards(runs, watched, [], (s) => ({
      role: "code", state: s.status === "working" ? "working" : "done", name: "Claude", line: "",
    }));
    expect(pillCards(cards, now).map((c) => c.key)).toEqual(["active", "claude:working", "recent-1", "recent-2"]);
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

describe("agentActivity", () => {
  const event = (sessionId: string, timestamp: string, kind: EventKind): AgentEvent => ({
    agent: "claude",
    sessionId,
    project: null,
    timestamp,
    kind,
  });
  // Newest first, as the board sends it.
  const feed = [
    event("a", "2026-10-03T10:04:00Z", { type: "toolResult", isError: true }),
    event("a", "2026-10-03T10:03:00Z", { type: "toolCall", tool: "Bash", summary: "npm test" }),
    event("b", "2026-10-03T10:02:30Z", { type: "toolCall", tool: "Read", summary: "other.rs" }),
    event("a", "2026-10-03T10:02:00Z", { type: "toolResult", isError: false }),
    event("a", "2026-10-03T10:01:00Z", { type: "toolCall", tool: "Edit", summary: "src/auth.rs" }),
    event("a", "2026-10-03T10:00:00Z", { type: "assistantText", text: "Looking", turnFinished: false }),
  ];

  it("lists one session's tool calls oldest first and marks the ones that failed", () => {
    expect(agentActivity(feed, "a")).toEqual([
      { at: "2026-10-03T10:01:00Z", tool: "Edit", summary: "src/auth.rs", failed: false },
      { at: "2026-10-03T10:03:00Z", tool: "Bash", summary: "npm test", failed: true },
    ]);
  });

  it("keeps only the most recent calls", () => {
    expect(agentActivity(feed, "a", 1).map((r) => r.tool)).toEqual(["Bash"]);
  });

  it("has nothing for an agent without a session", () => {
    expect(agentActivity(feed, undefined)).toEqual([]);
  });
});

describe("detail lines", () => {
  const now = new Date("2026-10-03T10:04:12Z").getTime();

  it("says now for the last minute", () => {
    expect(ago("2026-10-03T10:03:40Z", now)).toBe("now");
    expect(ago("2026-10-03T10:01:00Z", now)).toBe("3:12");
  });

  it("joins place, time and counts, leaving out what is zero", () => {
    const [card] = agentCards([run("a", "running")], [], [], () => {
      throw new Error("no sessions");
    });
    expect(detailMeta(card, now, 23, 1)).toBe("scratch · 4:12 · 23 tools · 1 failed");
    expect(detailMeta(card, now, 0, 0)).toBe("scratch · 4:12");
  });

  it("says when a finished run ended", () => {
    const finished = { ...run("a", "finished"), endedAt: "2026-10-03T10:00:12Z" };
    const [card] = agentCards([finished], [], [], () => {
      throw new Error("no sessions");
    });
    expect(detailMeta(card, now, 0, 0)).toBe("scratch · finished 4m ago");
  });
});

describe("unansweredCall", () => {
  const event = (sessionId: string, kind: EventKind): AgentEvent => ({
    agent: "claude",
    sessionId,
    project: null,
    timestamp: "2026-10-03T10:00:00Z",
    kind,
  });

  it("is the session's last tool call while no result has come back", () => {
    const feed = [
      event("b", { type: "toolResult", isError: false }),
      event("a", { type: "assistantText", text: "…", turnFinished: false }),
      event("a", { type: "toolCall", tool: "Bash", summary: "Delete the build folder" }),
      event("a", { type: "toolResult", isError: false }),
    ];
    expect(unansweredCall(feed, "a")?.summary).toBe("Delete the build folder");
  });

  it("is nothing once the call has its result", () => {
    const feed = [event("a", { type: "toolResult", isError: false }), event("a", { type: "toolCall", tool: "Bash", summary: "ls" })];
    expect(unansweredCall(feed, "a")).toBeNull();
    expect(unansweredCall(feed, undefined)).toBeNull();
  });
});

describe("requestVerb", () => {
  it("says run for shell commands and names other tools", () => {
    expect(requestVerb("Bash", "Bash")).toBe("Wants to run");
    expect(requestVerb("mcp__notion__create", "Notion · create pages")).toBe("Wants to use Notion · create pages");
  });
});

describe("tileLine", () => {
  const event = (sessionId: string, kind: EventKind): AgentEvent => ({
    agent: "claude",
    sessionId,
    project: null,
    timestamp: "2026-10-03T10:00:00Z",
    kind,
  });
  const cardFor = (r: RunSummary, approvals: PendingApproval[] = []) =>
    agentCards([r], [], approvals, () => {
      throw new Error("no sessions");
    })[0];

  it("says what a waiting agent wants", () => {
    const ask: PendingApproval = {
      runId: "a", agent: "claude", workdir: "", requestId: "q", tool: "Bash", label: "Bash",
      detail: "npm install", description: null, askedAt: "2026-10-03T10:00:00Z",
    };
    expect(tileLine(cardFor(run("a", "needsApproval"), [ask]), [])).toBe("Wants to run npm install");
  });

  it("shows the latest tool call while working, and the goal before there is one", () => {
    const feed = [event("a", { type: "toolCall", tool: "Edit", summary: "src/auth.rs" })];
    expect(tileLine(cardFor(run("a", "running")), feed)).toBe("Edit · src/auth.rs");
    expect(tileLine(cardFor(run("a", "running")), [])).toBe("Create a Notion page for this assignment");
  });

  it("sums up what a finished agent did", () => {
    expect(tileLine(cardFor(run("a", "finished", "code", "Fixed the session cookie.\nMore")), [])).toBe("Fixed the session cookie.");
    expect(tileLine(cardFor(run("a", "failed")), [])).toBe("Didn't finish. Open it to see the log.");
  });
});

describe("resultHeadline", () => {
  it("says what an errand made and where", () => {
    expect(resultHeadline("https://www.notion.so/Assignment-2-abc", null)).toEqual({
      title: "Page created in Notion",
      note: "Private draft · tell the assistant where it should live",
    });
    expect(resultHeadline("https://www.notion.so/x", "Uni Notes")?.note).toBe("Under Uni Notes");
    expect(resultHeadline("https://mail.google.com/mail/u/0/#drafts", null)?.title).toBe("Ready in Gmail");
    expect(resultHeadline("https://example.com", null)).toBeNull();
  });
});

describe("connectionLabel", () => {
  it("words each connection state, and says which ones won't hold a run up", () => {
    expect(connectionLabel("connected")).toEqual({ label: "Connected", tone: "done" });
    expect(connectionLabel("pending").label).toBe("Connecting…");
    expect(connectionLabel("needs-auth")).toMatchObject({ label: "Needs sign-in", note: "won't hold this up" });
    expect(connectionLabel("failed").tone).toBe("error");
  });
});

describe("toolName", () => {
  it("names app tools the way approvals do and leaves built-in tools alone", () => {
    expect(toolName("mcp__claude_ai_Notion__notion-search")).toBe("Notion · search");
    expect(toolName("mcp__claude_ai_Notion__notion-create-pages")).toBe("Notion · create pages");
    expect(toolName("mcp__claude_ai_Gmail__create_draft")).toBe("Gmail · create draft");
    expect(toolName("mcp__claude_ai_Google_Drive__search_files")).toBe("Google Drive · search files");
    expect(toolName("Read")).toBe("Read");
  });
});
