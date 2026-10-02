//! Parses Claude Code transcripts (`~/.claude/projects/<project>/<session>.jsonl`).

use serde_json::Value;

use crate::events::{
    AgentEvent, AgentKind, EventKind, is_injected, parse_time, summarize_tool_input, truncate,
};

pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let Ok(record) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let Some(session_id) = record.get("sessionId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let event = |kind: EventKind| AgentEvent {
        agent: AgentKind::Claude,
        session_id: session_id.to_string(),
        project: record.get("cwd").and_then(Value::as_str).map(str::to_string),
        timestamp: parse_time(record.get("timestamp")).unwrap_or_else(chrono::Utc::now),
        kind,
    };

    match record.get("type").and_then(Value::as_str) {
        Some("custom-title") | Some("ai-title") => record
            .get("customTitle")
            .or_else(|| record.get("aiTitle"))
            .and_then(Value::as_str)
            .map(|title| vec![event(EventKind::Title { title: title.to_string() })])
            .unwrap_or_default(),
        Some("user") if record.get("isMeta") != Some(&Value::Bool(true)) => {
            parse_user(&record["message"]).into_iter().map(event).collect()
        }
        Some("assistant") => parse_assistant(&record["message"]).into_iter().map(event).collect(),
        _ => Vec::new(),
    }
}

fn parse_user(message: &Value) -> Vec<EventKind> {
    match &message["content"] {
        Value::String(text) if !is_injected(text) => vec![EventKind::UserPrompt {
            text: truncate(text, 300),
        }],
        Value::Array(blocks) => {
            let mut kinds: Vec<EventKind> = blocks
                .iter()
                .filter(|b| b["type"] == "tool_result")
                .map(|b| EventKind::ToolResult {
                    is_error: b["is_error"].as_bool().unwrap_or(false),
                })
                .collect();
            let prompt = blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .filter(|text| !is_injected(text))
                .last();
            if let Some(text) = prompt {
                kinds.push(EventKind::UserPrompt { text: truncate(text, 300) });
            }
            kinds
        }
        _ => Vec::new(),
    }
}

fn parse_assistant(message: &Value) -> Vec<EventKind> {
    let turn_finished = message["stop_reason"] == "end_turn";
    let Some(blocks) = message["content"].as_array() else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter_map(|block| match block["type"].as_str()? {
            "text" => Some(EventKind::AssistantText {
                text: truncate(block["text"].as_str()?, 400),
                turn_finished,
            }),
            "tool_use" => Some(EventKind::ToolCall {
                tool: block["name"].as_str()?.to_string(),
                summary: summarize_tool_input(&block["input"]),
            }),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tool_use_and_end_turn() {
        let tool = r#"{"type":"assistant","sessionId":"s1","cwd":"C:\\dev\\x","timestamp":"2026-10-02T20:58:02.771Z","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls","description":"List files"}}]}}"#;
        let events = parse_line(tool);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0].kind, EventKind::ToolCall { tool, summary } if tool == "Bash" && summary == "List files"));
        assert_eq!(events[0].project.as_deref(), Some("C:\\dev\\x"));

        let done = r#"{"type":"assistant","sessionId":"s1","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"All done"}]}}"#;
        assert!(matches!(parse_line(done)[0].kind, EventKind::AssistantText { turn_finished: true, .. }));
    }

    #[test]
    fn skips_injected_context_in_prompts() {
        let line = r#"{"type":"user","sessionId":"s1","message":{"content":[{"type":"text","text":"<browser_instruction>…"},{"type":"text","text":"fix the bug"}]}}"#;
        let events = parse_line(line);
        assert!(matches!(&events[0].kind, EventKind::UserPrompt { text } if text == "fix the bug"));
    }

    #[test]
    fn reads_titles() {
        let line = r#"{"type":"custom-title","customTitle":"Parser setup","sessionId":"s1"}"#;
        assert!(matches!(&parse_line(line)[0].kind, EventKind::Title { title } if title == "Parser setup"));
    }
}
