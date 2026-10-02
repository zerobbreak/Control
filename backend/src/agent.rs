//! Agents Mission Control can start. Each one turns a routed goal into a command line and speaks
//! its CLI's host protocol, so other CLIs can sit beside Claude Code without the orchestrator
//! knowing their flags or message formats.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use serde_json::{Value, json};

use crate::events::{AgentKind, summarize_tool_input, truncate};
use crate::router::{Access, TaskKind, Tier};

/// Everything an agent needs to start one run.
pub struct Launch<'a> {
    /// Chosen by Mission Control, so the run can be matched to the transcript the watcher tails.
    pub session_id: &'a str,
    pub goal: &'a str,
    pub workdir: &'a Path,
    pub tier: Tier,
    pub access: Access,
}

/// An agent asking to use a tool its permission mode does not already allow.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// The agent's ID for this request; the answer must carry it back.
    pub request_id: String,
    pub tool: String,
    /// The most telling part of the input: the command, file or URL.
    pub detail: String,
    /// The agent's own short description of what the call is for, when it gives one.
    pub description: Option<String>,
    #[serde(skip)]
    pub input: Value,
}

/// What an agent's output means to the orchestrator.
#[derive(Debug, Clone, PartialEq)]
pub enum HostMessage {
    Approval(ApprovalRequest),
    /// The agent has finished the goal; closing its input lets it exit.
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Allow,
    /// Denied, with a reason the agent sees.
    Deny(String),
}

pub trait Agent: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn handles(&self, task: TaskKind) -> bool;
    /// The model this agent uses for a tier, as its CLI names it.
    fn model(&self, tier: Tier) -> &'static str;
    /// The command that runs `launch` with Mission Control as its host on stdin and stdout.
    fn command(&self, launch: &Launch) -> Command;
    /// The first line written to the agent's stdin: the goal itself.
    fn goal_message(&self, goal: &str) -> String;
    /// Reads one line of the agent's stdout. Most lines are progress the watcher already reports.
    fn parse(&self, line: &str) -> Option<HostMessage>;
    /// The stdin line that answers `request`.
    fn reply(&self, request: &ApprovalRequest, answer: &Answer) -> String;
}

/// Claude Code in print mode, driven over its stream-JSON control protocol.
pub struct ClaudeCode;

impl Agent for ClaudeCode {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }

    fn handles(&self, task: TaskKind) -> bool {
        matches!(task, TaskKind::Code | TaskKind::Question)
    }

    fn model(&self, tier: Tier) -> &'static str {
        match tier {
            Tier::Fast => "haiku",
            Tier::Balanced => "sonnet",
            Tier::Strongest => "opus",
        }
    }

    fn command(&self, launch: &Launch) -> Command {
        // The permission mode decides what runs without asking; everything else comes to
        // Mission Control as a `can_use_tool` request on stdout.
        let permission_mode = match launch.access {
            Access::ReadOnly => "plan",
            Access::EditFiles => "acceptEdits",
        };
        let mut cmd = Command::new("claude");
        cmd.current_dir(launch.workdir)
            .arg("--print")
            .args(["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
            .args(["--permission-prompt-tool", "stdio"])
            .args(["--model", self.model(launch.tier)])
            .args(["--session-id", launch.session_id])
            .args(["--permission-mode", permission_mode])
            .args(["--name", &truncate(launch.goal, 60)]);
        cmd
    }

    fn goal_message(&self, goal: &str) -> String {
        json!({"type": "user", "message": {"role": "user", "content": goal}}).to_string()
    }

    fn parse(&self, line: &str) -> Option<HostMessage> {
        let message: Value = serde_json::from_str(line).ok()?;
        match message["type"].as_str()? {
            "result" => Some(HostMessage::Finished),
            "control_request" if message["request"]["subtype"] == "can_use_tool" => {
                let request = &message["request"];
                let input = request["input"].clone();
                Some(HostMessage::Approval(ApprovalRequest {
                    request_id: message["request_id"].as_str()?.to_string(),
                    tool: request["tool_name"].as_str()?.to_string(),
                    detail: approval_detail(&input),
                    description: input["description"].as_str().map(|d| truncate(d, 200)),
                    input,
                }))
            }
            _ => None,
        }
    }

    fn reply(&self, request: &ApprovalRequest, answer: &Answer) -> String {
        let decision = match answer {
            Answer::Allow => json!({"behavior": "allow", "updatedInput": request.input}),
            Answer::Deny(reason) => json!({"behavior": "deny", "message": reason}),
        };
        json!({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": request.request_id, "response": decision},
        })
        .to_string()
    }
}

/// For approvals the exact command or path matters more than the agent's description of it.
fn approval_detail(input: &Value) -> String {
    ["command", "file_path", "url", "path"]
        .iter()
        .find_map(|key| input[key].as_str())
        .map(|value| truncate(value, 300))
        .unwrap_or_else(|| summarize_tool_input(input))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(access: Access) -> Launch<'static> {
        Launch {
            session_id: "0b6f3c2e-0000-4000-8000-000000000000",
            goal: "fix the login",
            workdir: Path::new("."),
            tier: Tier::Strongest,
            access,
        }
    }

    #[test]
    fn claude_command_carries_model_session_and_access() {
        let cmd = ClaudeCode.command(&launch(Access::ReadOnly));
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(cmd.get_program(), "claude");
        let after = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str());
        assert_eq!(after("--model"), Some("opus"));
        assert_eq!(after("--session-id"), Some("0b6f3c2e-0000-4000-8000-000000000000"));
        assert_eq!(after("--permission-mode"), Some("plan"));
        assert_eq!(after("--permission-prompt-tool"), Some("stdio"));
        // The goal itself goes in on stdin; the command line only names the session after it.
        assert_eq!(after("--name"), Some("fix the login"));
        assert_eq!(args.iter().filter(|a| *a == "fix the login").count(), 1);
    }

    // Recorded from Claude Code 2.1.288.
    const CAN_USE_TOOL: &str = r#"{"type":"control_request","request_id":"3b065c41","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"npm install @auth/core","description":"Install auth package"},"permission_suggestions":[],"tool_use_id":"toolu_01"}}"#;

    #[test]
    fn reads_permission_requests_and_the_end_of_the_goal() {
        let Some(HostMessage::Approval(request)) = ClaudeCode.parse(CAN_USE_TOOL) else {
            panic!("expected an approval request");
        };
        assert_eq!(request.request_id, "3b065c41");
        assert_eq!(request.tool, "Bash");
        assert_eq!(request.detail, "npm install @auth/core");
        assert_eq!(request.description.as_deref(), Some("Install auth package"));

        assert_eq!(ClaudeCode.parse(r#"{"type":"result","subtype":"success"}"#), Some(HostMessage::Finished));
        assert_eq!(ClaudeCode.parse(r#"{"type":"assistant","message":{}}"#), None);
        assert_eq!(ClaudeCode.parse("not json"), None);
    }

    #[test]
    fn replies_carry_the_request_id_and_decision() {
        let Some(HostMessage::Approval(request)) = ClaudeCode.parse(CAN_USE_TOOL) else { unreachable!() };

        let allow: Value = serde_json::from_str(&ClaudeCode.reply(&request, &Answer::Allow)).unwrap();
        assert_eq!(allow["type"], "control_response");
        assert_eq!(allow["response"]["request_id"], "3b065c41");
        assert_eq!(allow["response"]["response"]["behavior"], "allow");
        assert_eq!(allow["response"]["response"]["updatedInput"]["command"], "npm install @auth/core");

        let deny: Value = serde_json::from_str(&ClaudeCode.reply(&request, &Answer::Deny("No".into()))).unwrap();
        assert_eq!(deny["response"]["response"], json!({"behavior": "deny", "message": "No"}));
    }
}
