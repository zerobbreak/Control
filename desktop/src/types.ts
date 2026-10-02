// Mirrors the serialized types in backend/src/events.rs and backend/src/board.rs.

export type AgentKind = "claude" | "gemini";

export type SessionStatus = "working" | "stalled" | "waitingForUser" | "idle";

export type EventKind =
  | { type: "userPrompt"; text: string }
  | { type: "assistantText"; text: string; turnFinished: boolean }
  | { type: "toolCall"; tool: string; summary: string }
  | { type: "toolResult"; isError: boolean }
  | { type: "title"; title: string }
  | { type: "error"; message: string };

export type AgentEvent = {
  agent: AgentKind;
  sessionId: string;
  project: string | null;
  timestamp: string;
  kind: EventKind;
};

export type SessionSummary = {
  agent: AgentKind;
  sessionId: string;
  project: string | null;
  title: string | null;
  status: SessionStatus;
  startedAt: string;
  lastActivity: string;
  lastPrompt: string | null;
  currentActivity: string | null;
  lastMessage: string | null;
  toolCalls: number;
  toolErrors: number;
};

export type BoardSnapshot = {
  sessions: SessionSummary[];
  feed: AgentEvent[];
};

// Mirrors backend/src/router.rs and backend/src/orchestrator.rs.

export type TaskKind = "code" | "question" | "browse";
export type Tier = "fast" | "balanced" | "strongest";
export type Access = "readOnly" | "editFiles";

export type Decision = {
  task: TaskKind;
  tier: Tier;
  access: Access;
  reason: string;
};

export type RunStatus = "running" | "finished" | "failed" | "cancelled";

/** One goal handed to one agent. `id` is also the agent's sessionId on the board. */
export type RunSummary = {
  id: string;
  goal: string;
  workdir: string;
  agent: AgentKind;
  model: string;
  decision: Decision;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  logPath: string;
};
