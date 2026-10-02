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

export type RunStatus = "running" | "needsApproval" | "finished" | "failed" | "cancelled";

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
  /** Requests the Command Centre's rules answered without asking. */
  autoAllowed: number;
  autoDenied: number;
};

/** An agent asking to use a tool its permission mode does not already allow. */
export type PendingApproval = {
  runId: string;
  agent: AgentKind;
  workdir: string;
  requestId: string;
  tool: string;
  /** The command, file or URL the tool would act on. */
  detail: string;
  description: string | null;
  askedAt: string;
};

/** Mirrors backend/src/settings.rs: what the user lets Mission Control and its agents do. */
export type Settings = {
  claudeEnabled: boolean;
  watchOtherSessions: boolean;
  maxTier: Tier;
  maxBudgetUsd: number | null;
  askBeforeEdits: boolean;
  autoApprove: string[];
  readOnlyMode: boolean;
  fullAutonomy: boolean;
  allowedFolders: string[];
  agentCommit: GitRule;
  agentPush: GitRule;
  protectedBranches: string[];
};

/** What agents may do with one kind of git action. "ask" still follows full autonomy and the always-allow list. */
export type GitRule = "ask" | "allow" | "never";

// Mirrors backend/src/git.rs.

export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "typeChanged" | "untracked" | "conflicted";

export type FileChange = {
  path: string;
  original: string | null;
  staged: ChangeKind | null;
  unstaged: ChangeKind | null;
};

export type RepoStatus = {
  root: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  unborn: boolean;
  files: FileChange[];
  remotes: string[];
};

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
};
