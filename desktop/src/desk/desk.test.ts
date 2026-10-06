import { describe, expect, it } from "vitest";
import {
  agentRows,
  alwaysAllowPrefix,
  approvalTitle,
  autonomyLabel,
  buildTimeline,
  changedFiles,
  currentAction,
  dayLabel,
  doneToday,
  durationLabel,
  greeting,
  groupLabel,
  parseView,
  relativePath,
  runEvents,
  runPhases,
  spendLabel,
  statusLine,
  toolKind,
  watchedLine,
  workedFolders,
} from "./desk";
import type { AgentEvent, EventKind, PendingApproval, RunStatus, RunSummary, SessionSummary, Settings, TaskKind } from "../types";

function run(id: string, status: RunStatus, task: TaskKind = "code", extra: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    goal: `goal ${id}`,
    workdir: "C:\\dev\\Lumina",
    agent: "claude",
    model: "sonnet",
    decision: { task, tier: "balanced", access: task === "question" ? "readOnly" : "editFiles", reason: "" },
    status,
    exitCode: null,
    startedAt: "2026-10-06T10:00:00Z",
    endedAt: null,
    logPath: "",
    attachments: [],
    connections: [],
    result: null,
    autoAllowed: 0,
    autoDenied: 0,
    ...extra,
  };
}

let tick = 0;
function event(sessionId: string, kind: EventKind): AgentEvent {
  tick++;
  return { agent: "claude", sessionId, project: null, timestamp: new Date(Date.UTC(2026, 9, 6, 10, 0, tick)).toISOString(), kind };
}

const call = (tool: string, summary = "") => ({ type: "toolCall", tool, summary }) as EventKind;

function session(status: SessionSummary["status"], extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    agent: "claude",
    sessionId: "s",
    project: "C:\\dev\\notes",
    title: null,
    status,
    startedAt: "2026-10-06T10:00:00Z",
    lastActivity: "2026-10-06T10:00:00Z",
    lastPrompt: null,
    currentActivity: null,
    lastMessage: null,
    toolCalls: 0,
    toolErrors: 0,
    ...extra,
  };
}

const SETTINGS = {
  claudeEnabled: true,
  assistantEnabled: true,
  readOnlyMode: false,
  fullAutonomy: false,
  askBeforeEdits: true,
  capabilities: {},
} as unknown as Settings;

describe("parseView", () => {
  it("reads the views the pill asks for, and the old names", () => {
    expect(parseView("today")).toEqual({ kind: "today" });
    expect(parseView("activity")).toEqual({ kind: "today" });
    expect(parseView("changes")).toEqual({ kind: "changes" });
    expect(parseView("boundaries")).toEqual({ kind: "boundaries" });
    expect(parseView("command")).toEqual({ kind: "boundaries" });
    expect(parseView("run:abc")).toEqual({ kind: "run", runId: "abc" });
    expect(parseView("whatever")).toEqual({ kind: "today" });
  });
});

describe("Today's header", () => {
  it("greets by the time of day", () => {
    expect(greeting(8)).toBe("Good morning");
    expect(greeting(14)).toBe("Good afternoon");
    expect(greeting(21)).toBe("Good evening");
    expect(greeting(2)).toBe("Good evening");
  });

  it("names the day", () => {
    expect(dayLabel(new Date(2026, 9, 6))).toBe("Tuesday 6 October");
  });

  it("says what is at work and what is waiting", () => {
    expect(statusLine(2, 2)).toBe("Two agents are at work, and two things are waiting on you.");
    expect(statusLine(1, 0)).toBe("One agent is at work.");
    expect(statusLine(0, 1)).toBe("Nothing is running, but one thing is waiting on you.");
    expect(statusLine(0, 0)).toBe("Nothing is running. Give Mission Control a goal.");
    expect(statusLine(12, 1)).toBe("12 agents are at work, and one thing is waiting on you.");
  });
});

describe("runs", () => {
  it("keeps finished runs that ended today", () => {
    const now = new Date(2026, 9, 6, 20).getTime();
    const today = new Date(2026, 9, 6, 9).toISOString();
    const yesterday = new Date(2026, 9, 5, 9).toISOString();
    const runs = [run("a", "running"), run("b", "finished", "code", { endedAt: today }), run("c", "failed", "code", { endedAt: yesterday })];
    expect(doneToday(runs, now).map((r) => r.id)).toEqual(["b"]);
  });

  it("words durations", () => {
    const from = "2026-10-06T10:00:00Z";
    const at = (s: number) => new Date(from).getTime() + s * 1000;
    expect(durationLabel(from, at(41))).toBe("41 s");
    expect(durationLabel(from, at(161))).toBe("2 min 41 s");
    expect(durationLabel(from, at(3840))).toBe("1 h 4 min");
  });

  it("lists every folder worked in once, runs first", () => {
    const runs = [run("a", "running"), run("b", "finished")];
    expect(workedFolders(runs, [session("idle"), session("idle", { project: null })])).toEqual(["C:\\dev\\Lumina", "C:\\dev\\notes"]);
  });
});

describe("the feed for one run", () => {
  it("takes a run's events oldest first", () => {
    const feed = [event("a", call("Read", "2")), event("b", call("Read")), event("a", call("Read", "1"))];
    expect(runEvents(feed, "a").map((e) => (e.kind as { summary: string }).summary)).toEqual(["1", "2"]);
  });

  it("classifies tools", () => {
    expect(toolKind("Grep")).toBe("read");
    expect(toolKind("Write")).toBe("edit");
    expect(toolKind("Bash")).toBe("command");
    expect(toolKind("mcp__claude_ai_Notion__notion-search")).toBe("app");
    expect(toolKind("TodoWrite")).toBe("other");
  });

  it("fills progress from what the run has done, amber where it waits on you", () => {
    const events = [event("a", call("Read", "x")), event("a", call("Grep", "y"))];
    expect(runPhases(run("a", "needsApproval"), events).map((p) => p.state)).toEqual(["done", "done", "needs", "todo"]);
    expect(runPhases(run("a", "running"), []).map((p) => p.state)).toEqual(["done", "now", "todo", "todo"]);
    expect(runPhases(run("a", "running"), [], true).map((p) => p.state)).toEqual(["done", "needs", "todo", "todo"]);
    // A read-only question has nothing to change.
    expect(runPhases(run("a", "finished", "question"), []).map((p) => p.state)).toEqual(["done", "done", "done"]);
    const edited = [...events, event("a", call("Edit", "src/a.ts"))];
    expect(runPhases(run("a", "running"), edited).map((p) => p.state)).toEqual(["done", "done", "done", "now"]);
  });

  it("does not count an app search as a change", () => {
    const events = [event("a", call("mcp__claude_ai_Notion__notion-search", "brief"))];
    expect(runPhases(run("a", "running", "assistant"), events)[2].state).toBe("now");
    const made = [event("a", call("mcp__claude_ai_Notion__notion-create-pages", "brief"))];
    expect(runPhases(run("a", "running", "assistant"), made)[2].state).toBe("done");
  });

  it("names what the run is on", () => {
    expect(currentAction([event("a", call("Read", "src/a.ts"))])).toBe("Read · src/a.ts");
    expect(currentAction([event("a", { type: "assistantText", text: "\nLooking now", turnFinished: false })])).toBe("Looking now");
    expect(currentAction([])).toBeNull();
  });
});

describe("buildTimeline", () => {
  it("groups tool calls of one kind and marks failures", () => {
    const events = [
      event("a", { type: "userPrompt", text: "fix it" }),
      event("a", call("Read", "a.ts")),
      event("a", call("TodoWrite", "")),
      event("a", call("Grep", "cookie")),
      event("a", { type: "assistantText", text: "Found it.", turnFinished: false }),
      event("a", call("Edit", "C:\\dev\\Lumina\\src\\a.ts")),
      event("a", call("Edit", "C:\\dev\\Lumina\\src\\a.ts")),
      event("a", call("Write", "C:\\dev\\Lumina\\tests\\b.ts")),
      event("a", call("Bash", "npm test")),
      event("a", { type: "toolResult", isError: true }),
      event("a", { type: "title", title: "x" }),
      event("a", { type: "error", message: "boom" }),
    ];
    const items = buildTimeline(events);
    expect(items.map((i) => i.type)).toEqual(["prompt", "tools", "text", "tools", "tools", "error"]);
    const [prompt, reads, , edits, command] = items;
    expect(prompt).toMatchObject({ first: true });
    expect(reads.type === "tools" && groupLabel(reads)).toBe("Looked around · 3 actions");
    expect(edits.type === "tools" && groupLabel(edits)).toBe("Changed 2 files");
    expect(command.type === "tools" && groupLabel(command)).toBe("Ran a command · 1 failed");
  });

  it("names the app a group used", () => {
    const items = buildTimeline([event("a", call("mcp__claude_ai_Notion__notion-search", "x"))]);
    expect(items[0].type === "tools" && groupLabel(items[0])).toBe("Used Notion · 1 action");
  });
});

describe("changed files", () => {
  it("lists edited files once, relative to the run's folder", () => {
    const events = [
      event("a", call("Edit", "C:\\dev\\Lumina\\src\\a.ts")),
      event("a", call("Read", "C:\\dev\\Lumina\\src\\b.ts")),
      event("a", call("Write", "c:/dev/lumina/tests/c.ts")),
      event("a", call("Edit", "C:\\dev\\Lumina\\src\\a.ts")),
    ];
    expect(changedFiles(events, "C:\\dev\\Lumina")).toEqual(["src/a.ts", "tests/c.ts"]);
  });

  it("leaves paths outside the folder whole", () => {
    expect(relativePath("D:\\other\\x.ts", "C:\\dev\\Lumina")).toBe("D:\\other\\x.ts");
  });
});

describe("permission requests", () => {
  it("allows a command's program and subcommand from then on", () => {
    expect(alwaysAllowPrefix("Bash", "npm install @auth/core")).toBe("npm install");
    expect(alwaysAllowPrefix("Bash", "ls")).toBe("ls");
    expect(alwaysAllowPrefix("Bash", "python ./x.py")).toBe("python");
    expect(alwaysAllowPrefix("Bash", "npm test && rm -rf .")).toBeNull();
    expect(alwaysAllowPrefix("Edit", "src/a.ts")).toBeNull();
  });

  it("titles a request", () => {
    const base = { runId: "a", agent: "claude", workdir: "", requestId: "r", detail: "", description: null, askedAt: "" } as const;
    const ask = (tool: string, label: string): PendingApproval => ({ ...base, tool, label });
    expect(approvalTitle(ask("Bash", "Bash"), "Lumina")).toBe("Run a command in Lumina");
    expect(approvalTitle(ask("mcp__claude_ai_Notion__notion-create-pages", "Notion · create pages"), "your apps")).toBe("Create pages in Notion");
    expect(approvalTitle(ask("WebFetch", "WebFetch"), "Lumina")).toBe("Use WebFetch");
  });
});

describe("settings labels", () => {
  it("words autonomy and spend", () => {
    expect(autonomyLabel(SETTINGS)).toBe("Ask me");
    expect(autonomyLabel({ ...SETTINGS, fullAutonomy: true })).toBe("Full");
    expect(autonomyLabel({ ...SETTINGS, readOnlyMode: true, fullAutonomy: true })).toBe("Read only");
    expect(spendLabel(2)).toBe("up to $2.00");
    expect(spendLabel(null)).toBe("No limit");
  });
});

describe("sidebar agents", () => {
  it("lights each agent by its most urgent active run", () => {
    const runs = [run("a", "running"), run("b", "needsApproval"), run("c", "finished", "assistant")];
    const rows = agentRows(runs, { ...SETTINGS, capabilities: { browserControl: false } } as Settings);
    expect(rows.map((r) => [r.name, r.tone])).toEqual([
      ["Coding", "needs"],
      ["Assistant", "idle"],
      ["Browser", "off"],
    ]);
  });
});

describe("watched sessions", () => {
  it("says what a terminal session is up to", () => {
    const now = new Date("2026-10-06T10:04:30Z").getTime();
    expect(watchedLine(session("stalled"), now)).toBe("Quiet for 4 min, probably waiting on a prompt in your terminal.");
    expect(watchedLine(session("working", { currentActivity: "Editing a.ts" }), now)).toBe("Editing a.ts");
    expect(watchedLine(session("waitingForUser", { lastMessage: "\nAll done." }), now)).toBe("All done.");
    expect(watchedLine(session("idle"), now)).toMatch(/^Idle since \d\d:\d\d$/);
  });
});
