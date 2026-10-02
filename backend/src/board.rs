//! Rolls agent events up into one summary per session, plus a feed of recent events.

use std::collections::{HashMap, VecDeque};

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use crate::events::{AgentEvent, AgentKind, EventKind};

/// A session mid-turn with no activity for this long is probably stuck or waiting on a permission prompt.
const STALLED_AFTER: Duration = Duration::minutes(2);
/// A session with no activity for this long is no longer interesting.
const IDLE_AFTER: Duration = Duration::minutes(15);
const FEED_LEN: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Working,
    Stalled,
    WaitingForUser,
    Idle,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub agent: AgentKind,
    pub session_id: String,
    pub project: Option<String>,
    pub title: Option<String>,
    pub status: SessionStatus,
    pub started_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub last_prompt: Option<String>,
    /// What the agent is doing right now, e.g. "Edit · src/main.rs".
    pub current_activity: Option<String>,
    pub last_message: Option<String>,
    pub tool_calls: u32,
    pub tool_errors: u32,
    #[serde(skip)]
    turn_finished: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardSnapshot {
    pub sessions: Vec<SessionSummary>,
    pub feed: Vec<AgentEvent>,
}

#[derive(Default)]
pub struct Board {
    sessions: HashMap<(AgentKind, String), SessionSummary>,
    feed: VecDeque<AgentEvent>,
}

impl Board {
    pub fn apply(&mut self, event: AgentEvent) {
        let key = (event.agent, event.session_id.clone());
        let session = self.sessions.entry(key).or_insert_with(|| SessionSummary {
            agent: event.agent,
            session_id: event.session_id.clone(),
            project: None,
            title: None,
            status: SessionStatus::Idle,
            started_at: event.timestamp,
            last_activity: event.timestamp,
            last_prompt: None,
            current_activity: None,
            last_message: None,
            tool_calls: 0,
            tool_errors: 0,
            turn_finished: true,
        });

        if event.project.is_some() {
            session.project = event.project.clone();
        }
        session.last_activity = session.last_activity.max(event.timestamp);

        match &event.kind {
            EventKind::Title { title } => session.title = Some(title.clone()),
            EventKind::UserPrompt { text } => {
                session.last_prompt = Some(text.clone());
                session.current_activity = Some("Thinking".into());
                session.turn_finished = false;
            }
            EventKind::AssistantText { text, turn_finished } => {
                session.last_message = Some(text.clone());
                session.turn_finished = *turn_finished;
                if *turn_finished {
                    session.current_activity = None;
                }
            }
            EventKind::ToolCall { tool, summary } => {
                session.tool_calls += 1;
                session.turn_finished = false;
                session.current_activity = Some(if summary.is_empty() {
                    tool.clone()
                } else {
                    format!("{tool} · {summary}")
                });
            }
            EventKind::ToolResult { is_error } => {
                if *is_error {
                    session.tool_errors += 1;
                }
            }
            EventKind::Error { message } => session.last_message = Some(message.clone()),
        }

        // Titles are bookkeeping, not progress worth showing in the feed.
        if !matches!(event.kind, EventKind::Title { .. }) {
            self.feed.push_back(event);
            if self.feed.len() > FEED_LEN {
                self.feed.pop_front();
            }
        }
    }

    /// Drops every session, and its events, that `keep` rejects.
    pub fn forget_sessions_except(&mut self, keep: impl Fn(&str) -> bool) {
        self.sessions.retain(|(_, id), _| keep(id));
        self.feed.retain(|e| keep(&e.session_id));
    }

    pub fn snapshot(&self, now: DateTime<Utc>) -> BoardSnapshot {
        let mut sessions: Vec<SessionSummary> = self
            .sessions
            .values()
            .map(|s| SessionSummary { status: status_of(s, now), ..s.clone() })
            .collect();
        sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        BoardSnapshot { sessions, feed: self.feed.iter().rev().cloned().collect() }
    }
}

fn status_of(session: &SessionSummary, now: DateTime<Utc>) -> SessionStatus {
    let quiet_for = now - session.last_activity;
    if quiet_for > IDLE_AFTER {
        SessionStatus::Idle
    } else if session.turn_finished {
        SessionStatus::WaitingForUser
    } else if quiet_for > STALLED_AFTER {
        SessionStatus::Stalled
    } else {
        SessionStatus::Working
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(at: DateTime<Utc>, kind: EventKind) -> AgentEvent {
        AgentEvent { agent: AgentKind::Claude, session_id: "s".into(), project: None, timestamp: at, kind }
    }

    #[test]
    fn status_follows_the_turn() {
        let t0 = Utc::now();
        let mut board = Board::default();
        board.apply(event(t0, EventKind::UserPrompt { text: "go".into() }));
        board.apply(event(t0, EventKind::ToolCall { tool: "Edit".into(), summary: "a.rs".into() }));

        let snap = board.snapshot(t0 + Duration::seconds(10));
        assert_eq!(snap.sessions[0].status, SessionStatus::Working);
        assert_eq!(snap.sessions[0].current_activity.as_deref(), Some("Edit · a.rs"));
        assert_eq!(board.snapshot(t0 + Duration::minutes(5)).sessions[0].status, SessionStatus::Stalled);

        board.apply(event(t0, EventKind::AssistantText { text: "done".into(), turn_finished: true }));
        assert_eq!(board.snapshot(t0 + Duration::minutes(5)).sessions[0].status, SessionStatus::WaitingForUser);
        assert_eq!(board.snapshot(t0 + Duration::hours(1)).sessions[0].status, SessionStatus::Idle);
    }
}
