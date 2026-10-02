use chrono::{DateTime, Utc};
use serde::Serialize;

/// Which CLI produced an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Gemini,
}

/// One thing an agent did, normalised across CLIs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub agent: AgentKind,
    pub session_id: String,
    /// Working directory the agent runs in, when known.
    pub project: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub kind: EventKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EventKind {
    UserPrompt { text: String },
    /// `turn_finished` is true when the agent stopped and handed control back to the user.
    AssistantText { text: String, turn_finished: bool },
    ToolCall { tool: String, summary: String },
    ToolResult { is_error: bool },
    Title { title: String },
    Error { message: String },
}

pub(crate) fn truncate(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max_chars) {
        Some((idx, _)) => format!("{}…", &text[..idx]),
        None => text.to_string(),
    }
}

pub(crate) fn parse_time(value: Option<&serde_json::Value>) -> Option<DateTime<Utc>> {
    value?
        .as_str()?
        .parse::<DateTime<Utc>>()
        .ok()
}

/// Picks a short human description of a tool call from its arguments.
pub(crate) fn summarize_tool_input(input: &serde_json::Value) -> String {
    const KEYS: [&str; 8] = [
        "description",
        "file_path",
        "absolute_path",
        "command",
        "pattern",
        "path",
        "url",
        "query",
    ];
    let found = KEYS
        .iter()
        .find_map(|key| input.get(key).and_then(|v| v.as_str()))
        .or_else(|| {
            input
                .as_object()?
                .values()
                .find_map(|v| v.as_str())
        });
    truncate(found.unwrap_or_default(), 120)
}

/// Text that the CLI injected rather than the user typed (system context, command wrappers).
pub(crate) fn is_injected(text: &str) -> bool {
    text.trim_start().starts_with('<')
}
