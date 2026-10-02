//! Parses Gemini CLI transcripts (`~/.gemini/tmp/<project>/chats/session-*.jsonl`).
//!
//! The file starts with a metadata line, then appends either whole message records or
//! `{"$set": {"messages": [...]}}` updates that may repeat earlier messages, so the parser
//! keeps per-file state and only reports messages and tool calls it has not seen yet.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::events::{
    AgentEvent, AgentKind, EventKind, is_injected, parse_time, summarize_tool_input, truncate,
};

pub struct GeminiParser {
    session_id: String,
    project: Option<String>,
    seen_messages: HashSet<String>,
    seen_tool_calls: HashSet<String>,
    finished_tool_calls: HashSet<String>,
}

impl GeminiParser {
    /// `session_id` comes from the file name, because Gemini reuses `sessionId` values across files.
    pub fn new(session_id: String, project: Option<String>) -> Self {
        Self {
            session_id,
            project,
            seen_messages: HashSet::new(),
            seen_tool_calls: HashSet::new(),
            finished_tool_calls: HashSet::new(),
        }
    }

    /// Forgets what has been reported, for when the transcript is rewritten from scratch.
    pub fn reset(&mut self) {
        self.seen_messages.clear();
        self.seen_tool_calls.clear();
        self.finished_tool_calls.clear();
    }

    pub fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let messages: Vec<&Value> = if let Some(set) = record.get("$set") {
            set["messages"].as_array().map(|m| m.iter().collect()).unwrap_or_default()
        } else if record.get("id").is_some() && record.get("type").is_some() {
            vec![&record]
        } else {
            Vec::new()
        };
        messages.into_iter().flat_map(|m| self.parse_message(m)).collect()
    }

    fn parse_message(&mut self, message: &Value) -> Vec<AgentEvent> {
        let Some(id) = message["id"].as_str() else {
            return Vec::new();
        };
        let timestamp = parse_time(message.get("timestamp")).unwrap_or_else(Utc::now);
        let tool_calls = message["toolCalls"].as_array().cloned().unwrap_or_default();
        let mut kinds = Vec::new();

        if self.seen_messages.insert(id.to_string()) {
            let text = content_text(&message["content"]);
            match message["type"].as_str() {
                Some("user") if !text.is_empty() && !is_injected(&text) => {
                    kinds.push(EventKind::UserPrompt { text: truncate(&text, 300) });
                }
                Some("gemini") if !text.is_empty() => kinds.push(EventKind::AssistantText {
                    text: truncate(&text, 400),
                    turn_finished: tool_calls.is_empty(),
                }),
                Some("error") => kinds.push(EventKind::Error { message: truncate(&text, 300) }),
                _ => {}
            }
        }

        for call in &tool_calls {
            let call_id = call["id"].as_str().unwrap_or_default().to_string();
            if self.seen_tool_calls.insert(call_id.clone()) {
                kinds.push(EventKind::ToolCall {
                    tool: call["displayName"]
                        .as_str()
                        .or_else(|| call["name"].as_str())
                        .unwrap_or("tool")
                        .to_string(),
                    summary: summarize_tool_input(&call["args"]),
                });
            }
            let status = call["status"].as_str().unwrap_or_default();
            if matches!(status, "success" | "error" | "cancelled")
                && self.finished_tool_calls.insert(call_id)
            {
                kinds.push(EventKind::ToolResult { is_error: status != "success" });
            }
        }

        kinds.into_iter().map(|kind| self.event(timestamp, kind)).collect()
    }

    fn event(&self, timestamp: DateTime<Utc>, kind: EventKind) -> AgentEvent {
        AgentEvent {
            agent: AgentKind::Gemini,
            session_id: self.session_id.clone(),
            project: self.project.clone(),
            timestamp,
            kind,
        }
    }
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_set_updates_only_report_new_items() {
        let mut parser = GeminiParser::new("session-1".into(), None);
        let first = r#"{"$set":{"messages":[{"id":"m1","type":"user","content":[{"text":"add login"}]}]}}"#;
        let second = r#"{"$set":{"messages":[{"id":"m1","type":"user","content":[{"text":"add login"}]},{"id":"m2","type":"gemini","content":"Reading files","toolCalls":[{"id":"t1","name":"read_file","args":{"absolute_path":"C:\\x\\a.ts"},"status":"executing"}]}]}}"#;
        let third = r#"{"$set":{"messages":[{"id":"m2","type":"gemini","content":"Reading files","toolCalls":[{"id":"t1","name":"read_file","args":{},"status":"success"}]}]}}"#;

        assert!(matches!(&parser.parse_line(first)[..], [e] if matches!(&e.kind, EventKind::UserPrompt { text } if text == "add login")));

        let events = parser.parse_line(second);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0].kind, EventKind::AssistantText { turn_finished: false, .. }));
        assert!(matches!(&events[1].kind, EventKind::ToolCall { summary, .. } if summary == "C:\\x\\a.ts"));

        let events = parser.parse_line(third);
        assert!(matches!(&events[..], [e] if matches!(e.kind, EventKind::ToolResult { is_error: false })));
    }

    #[test]
    fn skips_session_context() {
        let mut parser = GeminiParser::new("s".into(), None);
        let line = r#"{"$set":{"messages":[{"id":"m1","type":"user","content":[{"text":"<session_context>\nThis is the Gemini CLI."}]}]}}"#;
        assert!(parser.parse_line(line).is_empty());
    }
}
