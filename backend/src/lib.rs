//! Mission Control core: starts agents on goals, and watches Claude Code and Gemini CLI sessions
//! to track their progress.

mod claude;
mod gemini;

pub mod agent;
pub mod board;
pub mod events;
pub mod orchestrator;
pub mod router;
pub mod watcher;

pub use agent::{Agent, ClaudeCode};
pub use board::{Board, BoardSnapshot, SessionStatus, SessionSummary};
pub use events::{AgentEvent, AgentKind, EventKind};
pub use orchestrator::{Orchestrator, RunStatus, RunSummary, RuntimeConfig, StartError};
pub use router::{Access, Decision, TaskKind, Tier};
pub use watcher::{TranscriptWatcher, WatcherConfig};
