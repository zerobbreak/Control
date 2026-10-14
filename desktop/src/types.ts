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

export type TaskKind = "code" | "question" | "browse" | "assistant";
export type Tier = "fast" | "balanced" | "strongest";
export type Access = "readOnly" | "editFiles" | "useApps";

export type Decision = {
  task: TaskKind;
  tier: Tier;
  access: Access;
  reason: string;
};

/** "starting": waiting for the agent's app connections before it gets the goal. */
export type RunStatus = "starting" | "running" | "needsApproval" | "finished" | "failed" | "cancelled";

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
  /** The files and folders handed over with the goal. */
  attachments: string[];
  /** How the agent's app connections went while it started; empty for agents without apps. */
  connections: { name: string; status: string }[];
  /** The agent's final answer, in full, once it has finished. */
  result: string | null;
  /** Requests the Boundaries rules answered without asking. */
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
  /** The tool as a person would name it, e.g. "Notion · create pages". */
  label: string;
  /** The command, file, URL or title the tool would act on. */
  detail: string;
  description: string | null;
  askedAt: string;
};

/** Mirrors backend/src/settings.rs: what the user lets Mission Control and its agents do. */
export type Settings = {
  claudeEnabled: boolean;
  /** Which CLI takes code goals and questions about folders. */
  codingAgent: "claude" | "gemini";
  assistantEnabled: boolean;
  /** Where new Notion pages go when a goal does not say. */
  notionParent: string | null;
  /** Searching and opening in connected apps runs without asking. */
  readAppsFreely: boolean;
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
  /** How much agents may do in each app, keyed by its tool-name id such as "claude_ai_Notion". */
  appAccess: Record<string, AppAccess>;
  /** The user's answer for each capability; missing means not asked yet. */
  capabilities: Partial<Record<Capability, boolean>>;
};

/** Things Mission Control can do on the computer that the user must allow first. Mirrors backend/src/settings.rs. */
export type Capability = "browserControl" | "recycleFiles" | "mediaControls";

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

// Mirrors backend/src/apps.rs.

/** Read: look only. Ask: you approve each change. Act: changes go ahead on their own. */
export type AppAccess = "read" | "ask" | "act";
export type AppStatus = "connected" | "needsAuth" | "failed";

export type App = {
  /** As a person would name it, e.g. "Notion". */
  name: string;
  /** The server part of its tool names, e.g. "claude_ai_Notion". */
  id: string;
  status: AppStatus;
};

// Mirrors backend/src/context.rs.

/** "link" is a Windows internet shortcut: it points somewhere, such as a Google Drive file. */
export type ContextKind = "folder" | "image" | "pdf" | "link" | "file" | "missing";

/** A file or folder handed over with a goal. */
export type ContextItem = {
  path: string;
  name: string;
  kind: ContextKind;
  /** A folder's git branch, or a file's type and size. */
  detail: string;
  /** A folder that is a code project, so a goal can run in it. Loose folders are only looked at. */
  project: boolean;
};

// Mirrors Preview in backend/src/orchestrator.rs.

/** What a goal would start, shown for review before it does. */
export type Preview = {
  decision: Decision;
  workdir: string;
  model: string;
  askBeforeEdits: boolean;
  fullAutonomy: boolean;
  /** A capability the run needs the user's permission for. */
  capability: Capability | null;
  /** The answer so far: allowed, not allowed, or null if not asked yet. */
  capabilityGranted: boolean | null;
};

// Mirrors backend/src/media.rs.

export type NowPlaying = { title: string; artist: string | null; app: string; playing: boolean };
export type MediaAction = "playPause" | "next" | "previous" | "volumeUp" | "volumeDown" | "mute";

/** A coding CLI Mission Control can start; `version` is null when it is not installed. */
export type CliStatus = { id: "claude" | "gemini"; name: string; version: string | null };
