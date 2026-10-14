//! Mission Control core: starts agents on goals, and watches Claude Code and Gemini CLI sessions
//! to track their progress.

mod claude;
mod gemini;

pub mod agent;
pub mod apps;
pub mod board;
pub mod context;
pub mod events;
pub mod git;
pub mod jev;
pub mod media;
pub mod model_router;
pub mod orchestrator;
pub mod router;
pub mod settings;
pub mod watcher;

pub use apps::{App, AppAccess, AppStatus};
pub use agent::{Agent, AppConnection, Answer, ApprovalRequest, ClaudeAssistant, ClaudeBrowser, ClaudeCode, GeminiCli, GEMINI_PROGRAM};
pub use context::{ContextItem, ContextKind};
pub use model_router::ModelRouter;
pub use board::{Board, BoardSnapshot, SessionStatus, SessionSummary};
pub use events::{AgentEvent, AgentKind, EventKind};
pub use orchestrator::{Orchestrator, PendingApproval, Preview, RecycleError, RunStatus, RunSummary, RuntimeConfig, StartError};
pub use router::{Access, Context, Decision, TaskKind, Tier};
pub use git::{GitError, GitRepo, PullRequest, RepoStatus};
pub use settings::{Capability, CodingAgent, GitRule, Settings};
pub use watcher::{TranscriptWatcher, WatcherConfig};
