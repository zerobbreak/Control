//! Mission Control core: starts agents on goals, and watches Claude Code and Gemini CLI sessions
//! to track their progress.

mod claude;
mod gemini;

pub mod agent;
pub mod board;
pub mod events;
pub mod git;
pub mod orchestrator;
pub mod router;
pub mod settings;
pub mod watcher;

pub use agent::{Agent, Answer, ApprovalRequest, ClaudeAssistant, ClaudeCode};
pub use board::{Board, BoardSnapshot, SessionStatus, SessionSummary};
pub use events::{AgentEvent, AgentKind, EventKind};
pub use orchestrator::{Orchestrator, PendingApproval, RunStatus, RunSummary, RuntimeConfig, StartError};
pub use router::{Access, Context, Decision, TaskKind, Tier};
pub use git::{GitError, GitRepo, PullRequest, RepoStatus};
pub use settings::{GitRule, Settings};
pub use watcher::{TranscriptWatcher, WatcherConfig};
