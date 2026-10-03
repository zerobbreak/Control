//! Agents Mission Control can start. Each one turns a routed goal into a command line and speaks
//! its CLI's host protocol, so other CLIs can sit beside Claude Code without the orchestrator
//! knowing their flags or message formats.

use std::path::{Path, PathBuf};
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
    /// Files or folders the user handed over with the goal, such as a dropped PDF.
    pub attachments: &'a [PathBuf],
    pub tier: Tier,
    pub access: Access,
    /// Send file edits for approval too, instead of letting code runs edit freely.
    pub ask_before_edits: bool,
    /// Stop the run once it has spent this much, in US dollars.
    pub max_budget_usd: Option<f64>,
    /// Where new Notion pages go when the goal does not say.
    pub notion_parent: Option<&'a str>,
}

/// An agent asking to use a tool its permission mode does not already allow.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// The agent's ID for this request; the answer must carry it back.
    pub request_id: String,
    pub tool: String,
    /// The tool as a person would name it, e.g. "Notion · create pages".
    pub label: String,
    /// The most telling part of the input: the command, file, URL or title.
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
    /// Answer to a readiness probe: true once the agent's app connections have settled.
    Ready(bool),
    /// The agent has finished the goal, with its final answer; closing its input lets it exit.
    Finished(Option<String>),
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
    /// A stdin line asking whether the agent is ready for its goal, for agents that must
    /// connect to apps first. The answer comes back as `HostMessage::Ready`.
    fn readiness_probe(&self) -> Option<String> {
        None
    }
    /// The stdin line that hands the agent its goal and any attachments.
    fn goal_message(&self, goal: &str, attachments: &[PathBuf]) -> String;
    /// Reads one line of the agent's stdout. Most lines are progress the watcher already reports.
    fn parse(&self, line: &str) -> Option<HostMessage>;
    /// The stdin line that answers `request`.
    fn reply(&self, request: &ApprovalRequest, answer: &Answer) -> String;
}

/// Claude Code working in a folder: reading, answering questions and changing code.
pub struct ClaudeCode;

/// Claude Code as a general assistant: it reads the files it is given and works in the user's
/// apps through their claude.ai connectors, but cannot run commands or change files.
pub struct ClaudeAssistant;

impl Agent for ClaudeCode {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }

    fn handles(&self, task: TaskKind) -> bool {
        matches!(task, TaskKind::Code | TaskKind::Question)
    }

    fn model(&self, tier: Tier) -> &'static str {
        claude_model(tier)
    }

    fn command(&self, launch: &Launch) -> Command {
        // The permission mode decides what runs without asking; everything else comes to
        // Mission Control as a `can_use_tool` request on stdout.
        let permission_mode = match launch.access {
            Access::ReadOnly => "plan",
            Access::EditFiles if !launch.ask_before_edits => "acceptEdits",
            Access::EditFiles | Access::UseApps => "default",
        };
        let mut cmd = claude_command(launch, permission_mode);
        if let Some(usd) = launch.max_budget_usd {
            cmd.args(["--max-budget-usd", &format!("{usd:.2}")]);
        }
        cmd
    }

    fn goal_message(&self, goal: &str, attachments: &[PathBuf]) -> String {
        claude_goal_message(goal, attachments)
    }

    fn parse(&self, line: &str) -> Option<HostMessage> {
        claude_parse(line)
    }

    fn reply(&self, request: &ApprovalRequest, answer: &Answer) -> String {
        claude_reply(request, answer)
    }
}

/// Connector tools that only read, so they run without asking. Anything that creates, changes
/// or sends still comes to the user for approval.
const READ_ONLY_CONNECTOR_TOOLS: &[&str] = &[
    "mcp__claude_ai_Notion__notion-search",
    "mcp__claude_ai_Notion__notion-ai-search",
    "mcp__claude_ai_Notion__notion-fetch",
    "mcp__claude_ai_Notion__notion-get-users",
    "mcp__claude_ai_Notion__notion-get-teams",
    "mcp__claude_ai_Notion__notion-list-recent-pages",
    "mcp__claude_ai_Notion__notion-list-shared-pages",
    "mcp__claude_ai_Notion__notion-list-private-pages",
    "mcp__claude_ai_Notion__notion-list-favorite-pages",
    "mcp__claude_ai_Gmail__search_threads",
    "mcp__claude_ai_Gmail__get_thread",
    "mcp__claude_ai_Gmail__get_message",
    "mcp__claude_ai_Gmail__list_labels",
];

const ASSISTANT_PROMPT: &str = "You are the assistant inside Mission Control, a desktop app. The \
user's goals here are about their documents and apps, not code. Read any attached files the \
message lists, and use the connected app tools (such as Notion or Gmail) to do what the user \
asks. You cannot run commands or change files on this computer. Keep anything you create clear \
and well structured, and end your reply with a link to whatever you created or changed.";

impl Agent for ClaudeAssistant {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }

    fn handles(&self, task: TaskKind) -> bool {
        task == TaskKind::Assistant
    }

    fn model(&self, tier: Tier) -> &'static str {
        claude_model(tier)
    }

    fn command(&self, launch: &Launch) -> Command {
        // App actions ask unless read-only; local files can only be read.
        let permission_mode = if launch.access == Access::ReadOnly { "plan" } else { "default" };
        let mut prompt = ASSISTANT_PROMPT.to_string();
        if let Some(parent) = launch.notion_parent {
            prompt.push_str(&format!(
                " When you create a Notion page and the user has not said where, put it under: {parent}."
            ));
        }
        let mut cmd = claude_command(launch, permission_mode);
        cmd.args(["--tools", "Read,Glob,Grep"])
            .arg("--allowedTools")
            .arg(READ_ONLY_CONNECTOR_TOOLS.join(","))
            .args(["--append-system-prompt", &prompt]);
        if let Some(usd) = launch.max_budget_usd {
            cmd.args(["--max-budget-usd", &format!("{usd:.2}")]);
        }
        cmd
    }

    /// Asks for the status of the claude.ai connectors, which connect after the run starts.
    fn readiness_probe(&self) -> Option<String> {
        let id = format!("ready-{}", uuid::Uuid::new_v4());
        Some(json!({"type": "control_request", "request_id": id, "request": {"subtype": "mcp_status"}}).to_string())
    }

    fn goal_message(&self, goal: &str, attachments: &[PathBuf]) -> String {
        claude_goal_message(goal, attachments)
    }

    fn parse(&self, line: &str) -> Option<HostMessage> {
        claude_parse(line)
    }

    fn reply(&self, request: &ApprovalRequest, answer: &Answer) -> String {
        claude_reply(request, answer)
    }
}

fn claude_model(tier: Tier) -> &'static str {
    match tier {
        Tier::Fast => "haiku",
        Tier::Balanced => "sonnet",
        Tier::Strongest => "opus",
    }
}

/// The flags every hosted Claude Code run shares.
fn claude_command(launch: &Launch, permission_mode: &str) -> Command {
    let mut cmd = Command::new("claude");
    cmd.current_dir(launch.workdir)
        .arg("--print")
        .args(["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .args(["--permission-prompt-tool", "stdio"])
        .args(["--model", claude_model(launch.tier)])
        .args(["--session-id", launch.session_id])
        .args(["--permission-mode", permission_mode])
        .args(["--name", &truncate(launch.goal, 60)]);
    // Attachments usually live outside the working folder; let the run read where they are.
    for dir in attachment_dirs(launch.attachments) {
        cmd.arg("--add-dir").arg(dir);
    }
    cmd
}

fn attachment_dirs(attachments: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = attachments
        .iter()
        .filter_map(|a| if a.is_dir() { Some(a.clone()) } else { a.parent().map(Path::to_path_buf) })
        .collect();
    dirs.sort();
    dirs.dedup();
    dirs
}

fn claude_goal_message(goal: &str, attachments: &[PathBuf]) -> String {
    let mut content = goal.to_string();
    if !attachments.is_empty() {
        content.push_str("\n\nAttached:");
        for path in attachments {
            content.push_str(&format!("\n- {}", path.display()));
        }
    }
    json!({"type": "user", "message": {"role": "user", "content": content}}).to_string()
}

fn claude_parse(line: &str) -> Option<HostMessage> {
    let message: Value = serde_json::from_str(line).ok()?;
    match message["type"].as_str()? {
        "result" => Some(HostMessage::Finished(message["result"].as_str().map(str::to_string))),
        "control_request" if message["request"]["subtype"] == "can_use_tool" => {
            let request = &message["request"];
            let tool = request["tool_name"].as_str()?.to_string();
            let input = request["input"].clone();
            Some(HostMessage::Approval(ApprovalRequest {
                request_id: message["request_id"].as_str()?.to_string(),
                label: tool_label(&tool),
                detail: approval_detail(&tool, &input),
                description: input["description"].as_str().map(|d| truncate(d, 200)),
                tool,
                input,
            }))
        }
        // The answer to a readiness probe lists every connector and its status.
        "control_response" => {
            let servers = message["response"]["response"]["mcpServers"].as_array()?;
            Some(HostMessage::Ready(servers.iter().all(|s| s["status"] != "pending")))
        }
        _ => None,
    }
}

fn claude_reply(request: &ApprovalRequest, answer: &Answer) -> String {
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

/// `mcp__claude_ai_Notion__notion-create-pages` reads as "Notion · create pages".
fn tool_label(tool: &str) -> String {
    let mut parts = tool.splitn(3, "__");
    let (Some("mcp"), Some(server), Some(action)) = (parts.next(), parts.next(), parts.next()) else {
        return tool.to_string();
    };
    let app = server.strip_prefix("claude_ai_").unwrap_or(server).replace('_', " ");
    let action = action.strip_prefix(&format!("{}-", app.to_lowercase())).unwrap_or(action);
    format!("{app} · {}", action.replace(['-', '_'], " "))
}

/// For approvals the exact command, path or title matters more than the agent's description.
fn approval_detail(tool: &str, input: &Value) -> String {
    if let Some(value) = ["command", "file_path", "url", "path"].iter().find_map(|key| input[key].as_str()) {
        return truncate(value, 300);
    }
    if tool.starts_with("mcp__") {
        if let Some(title) = find_title(input, 0) {
            return format!("“{}”", truncate(&title, 200));
        }
    }
    summarize_tool_input(input)
}

/// The first title anywhere in a connector call's input, such as a new Notion page's.
fn find_title(value: &Value, depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    match value {
        Value::Object(map) => {
            for key in ["title", "subject", "name"] {
                if let Some(text) = map.get(key).and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    return Some(text.to_string());
                }
            }
            map.values().find_map(|v| find_title(v, depth + 1))
        }
        Value::Array(items) => items.iter().find_map(|v| find_title(v, depth + 1)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_FILES: &[PathBuf] = &[];

    fn launch(access: Access) -> Launch<'static> {
        Launch {
            session_id: "0b6f3c2e-0000-4000-8000-000000000000",
            goal: "fix the login",
            workdir: Path::new("."),
            attachments: NO_FILES,
            tier: Tier::Strongest,
            access,
            ask_before_edits: false,
            max_budget_usd: None,
            notion_parent: None,
        }
    }

    fn args(cmd: &Command) -> Vec<String> {
        cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str())
    }

    #[test]
    fn claude_command_carries_model_session_and_access() {
        let cmd = ClaudeCode.command(&launch(Access::ReadOnly));
        let args = args(&cmd);
        assert_eq!(cmd.get_program(), "claude");
        assert_eq!(after(&args, "--model"), Some("opus"));
        assert_eq!(after(&args, "--session-id"), Some("0b6f3c2e-0000-4000-8000-000000000000"));
        assert_eq!(after(&args, "--permission-mode"), Some("plan"));
        assert_eq!(after(&args, "--permission-prompt-tool"), Some("stdio"));
        // The goal itself goes in on stdin; the command line only names the session after it.
        assert_eq!(after(&args, "--name"), Some("fix the login"));
        assert_eq!(args.iter().filter(|a| *a == "fix the login").count(), 1);
        assert_eq!(after(&args, "--max-budget-usd"), None);
        assert_eq!(ClaudeCode.readiness_probe(), None, "code runs start straight away");
    }

    #[test]
    fn command_centre_limits_reach_the_command_line() {
        let mut launch = launch(Access::EditFiles);
        let mode = |launch: &Launch| {
            let args = args(&ClaudeCode.command(launch));
            (after(&args, "--permission-mode").unwrap().to_string(), after(&args, "--max-budget-usd").map(str::to_string))
        };
        assert_eq!(mode(&launch), ("acceptEdits".into(), None));
        launch.ask_before_edits = true;
        launch.max_budget_usd = Some(1.5);
        assert_eq!(mode(&launch), ("default".into(), Some("1.50".into())));
    }

    #[test]
    fn the_assistant_reads_files_and_uses_apps_but_runs_nothing() {
        let file = std::env::temp_dir().join("assignment.pdf");
        let attachments = [file.clone()];
        let mut launch = launch(Access::UseApps);
        launch.attachments = &attachments;
        launch.notion_parent = Some("Uni Notes");
        let args = args(&ClaudeAssistant.command(&launch));

        assert_eq!(after(&args, "--tools"), Some("Read,Glob,Grep"));
        assert_eq!(after(&args, "--permission-mode"), Some("default"));
        assert_eq!(after(&args, "--add-dir"), file.parent().and_then(Path::to_str));
        let allowed = after(&args, "--allowedTools").unwrap();
        assert!(allowed.contains("notion-search") && !allowed.contains("create"));
        assert!(after(&args, "--append-system-prompt").unwrap().contains("under: Uni Notes"));

        let message: Value = serde_json::from_str(&ClaudeAssistant.goal_message("Make a page", &attachments)).unwrap();
        let content = message["message"]["content"].as_str().unwrap();
        assert!(content.starts_with("Make a page") && content.contains(file.to_str().unwrap()));
    }

    #[test]
    fn readiness_waits_for_every_connector_to_settle() {
        let probe: Value = serde_json::from_str(&ClaudeAssistant.readiness_probe().unwrap()).unwrap();
        assert_eq!(probe["request"]["subtype"], "mcp_status");

        // Recorded from Claude Code 2.1.288, trimmed.
        let status = |notion: &str| {
            format!(
                r#"{{"type":"control_response","response":{{"subtype":"success","request_id":"s1","response":{{"mcpServers":[{{"name":"claude.ai Gmail","status":"connected"}},{{"name":"claude.ai Notion","status":"{notion}"}},{{"name":"claude.ai Google Drive","status":"needs-auth"}}]}}}}}}"#
            )
        };
        assert_eq!(claude_parse(&status("pending")), Some(HostMessage::Ready(false)));
        assert_eq!(claude_parse(&status("connected")), Some(HostMessage::Ready(true)));
        assert_eq!(claude_parse(&status("failed")), Some(HostMessage::Ready(true)), "a failed connector does not hold the run up");
    }

    // Recorded from Claude Code 2.1.288.
    const CAN_USE_TOOL: &str = r#"{"type":"control_request","request_id":"3b065c41","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"npm install @auth/core","description":"Install auth package"},"permission_suggestions":[],"tool_use_id":"toolu_01"}}"#;

    #[test]
    fn reads_permission_requests_and_the_end_of_the_goal() {
        let Some(HostMessage::Approval(request)) = ClaudeCode.parse(CAN_USE_TOOL) else {
            panic!("expected an approval request");
        };
        assert_eq!(request.request_id, "3b065c41");
        assert_eq!((request.tool.as_str(), request.label.as_str()), ("Bash", "Bash"));
        assert_eq!(request.detail, "npm install @auth/core");
        assert_eq!(request.description.as_deref(), Some("Install auth package"));

        assert_eq!(ClaudeCode.parse(r#"{"type":"result","subtype":"success"}"#), Some(HostMessage::Finished(None)));
        assert_eq!(
            ClaudeCode.parse(r#"{"type":"result","subtype":"success","result":"Done: https://notion.so/x"}"#),
            Some(HostMessage::Finished(Some("Done: https://notion.so/x".into())))
        );
        assert_eq!(ClaudeCode.parse(r#"{"type":"assistant","message":{}}"#), None);
        assert_eq!(ClaudeCode.parse("not json"), None);
    }

    #[test]
    fn connector_requests_read_as_the_app_and_what_it_would_create() {
        let line = r#"{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"mcp__claude_ai_Notion__notion-create-pages","input":{"parent":{"page_id":"abc"},"pages":[{"properties":{"title":"Assignment 3 – Database Design"},"content":"..."}]}}}"#;
        let Some(HostMessage::Approval(request)) = ClaudeAssistant.parse(line) else { panic!() };
        assert_eq!(request.label, "Notion · create pages");
        assert_eq!(request.detail, "“Assignment 3 – Database Design”");
        assert_eq!(tool_label("mcp__claude_ai_Gmail__create_draft"), "Gmail · create draft");
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
