//! Mission Control core: watches Claude Code and Gemini CLI sessions and tracks their progress.

mod claude;
mod gemini;

pub mod board;
pub mod events;
pub mod watcher;

pub use board::{Board, BoardSnapshot, SessionStatus, SessionSummary};
pub use events::{AgentEvent, AgentKind, EventKind};
pub use watcher::{TranscriptWatcher, WatcherConfig};
