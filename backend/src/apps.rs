//! The apps agents can work in: the MCP connectors Claude Code knows about, such as the claude.ai
//! Notion and Gmail connectors, and how much the user lets agents do in each.

use std::process::Command;

use serde::{Deserialize, Serialize};

/// How much agents may do in one app without asking. Reading is never asked about.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppAccess {
    /// Look only: anything that creates, changes or sends is refused.
    Read,
    /// Changes come to the user to approve, one at a time.
    #[default]
    Ask,
    /// Changes go ahead on their own.
    Act,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppStatus {
    Connected,
    /// Set up, but the user still has to sign in to it.
    NeedsAuth,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    /// The app as a person would name it, e.g. "Notion".
    pub name: String,
    /// The server part of its tool names, e.g. "claude_ai_Notion" in
    /// `mcp__claude_ai_Notion__notion-search`. Access settings are keyed by it.
    pub id: String,
    pub status: AppStatus,
}

/// A claude.ai connector a goal can name, and the words that name it.
pub struct Connector {
    pub name: &'static str,
    /// The server id used in tool names, e.g. "claude_ai_Gmail".
    pub id: &'static str,
    words: &'static [&'static str],
}

pub const CONNECTORS: &[Connector] = &[
    Connector { name: "Notion", id: "claude_ai_Notion", words: &["notion"] },
    Connector { name: "Gmail", id: "claude_ai_Gmail", words: &["gmail", "email", "e-mail", "inbox"] },
    Connector { name: "Google Drive", id: "claude_ai_Google_Drive", words: &["google drive", "gdrive", "google docs", "google sheets"] },
    Connector { name: "Google Calendar", id: "claude_ai_Google_Calendar", words: &["google calendar", "calendar"] },
    Connector { name: "Microsoft 365", id: "claude_ai_Microsoft_365", words: &["microsoft 365", "outlook", "onedrive", "sharepoint"] },
];

/// The connectors a goal names. When it names some, only those need to load and connect; a goal
/// that names none could use any app, so it gets them all.
pub fn target_apps(goal: &str) -> Vec<&'static Connector> {
    let goal = goal.to_lowercase();
    CONNECTORS.iter().filter(|c| c.words.iter().any(|w| mentions(&goal, w))).collect()
}

/// Whether `word` appears in `text` as a word of its own (a trailing plural "s" is fine).
fn mentions(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + word.len()..].trim_start_matches('s').chars().next();
        !before.is_some_and(|c| c.is_alphanumeric()) && !after.is_some_and(|c| c.is_alphanumeric())
    })
}

/// Asks Claude Code which MCP servers it has and whether each is connected. This checks every
/// server's health, so it takes a few seconds.
pub fn list_apps() -> std::io::Result<Vec<App>> {
    let mut cmd = Command::new("claude");
    cmd.args(["mcp", "list"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output()?;
    if !output.status.success() {
        return Err(std::io::Error::other(String::from_utf8_lossy(&output.stderr).trim().to_string()));
    }
    Ok(parse_mcp_list(&String::from_utf8_lossy(&output.stdout)))
}

/// Reads `claude mcp list` lines such as `claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected`.
pub fn parse_mcp_list(text: &str) -> Vec<App> {
    text.lines()
        .filter_map(|line| {
            let (server, rest) = line.split_once(": ")?;
            let (_, health) = rest.rsplit_once(" - ")?;
            let health = health.to_lowercase();
            let status = if health.contains("connected") && !health.contains("not connected") {
                AppStatus::Connected
            } else if health.contains("auth") {
                AppStatus::NeedsAuth
            } else {
                AppStatus::Failed
            };
            let name = server.strip_prefix("claude.ai ").unwrap_or(server).trim().to_string();
            Some(App { name, id: server_id(server.trim()), status })
        })
        .collect()
}

/// Claude Code turns a server's name into the middle of its tool names by replacing anything
/// other than letters, digits, `_` and `-` with `_`: "claude.ai Google Drive" becomes
/// "claude_ai_Google_Drive".
pub fn server_id(server: &str) -> String {
    server.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

/// The app a tool belongs to, as its server id, for MCP tools such as
/// `mcp__claude_ai_Notion__notion-create-pages`. Built-in tools like Bash have none.
pub fn app_of_tool(tool: &str) -> Option<&str> {
    let rest = tool.strip_prefix("mcp__")?;
    let (server, _) = rest.split_once("__")?;
    Some(server)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_goal_names_the_services_it_needs() {
        let names = |goal: &str| target_apps(goal).iter().map(|c| c.name).collect::<Vec<_>>();
        assert_eq!(names("Make a Notion page about my week"), ["Notion"]);
        assert_eq!(names("Summarise my emails into notion"), ["Notion", "Gmail"]);
        assert!(names("Tidy up my downloads").is_empty());
        assert!(names("Fix the denotionation bug").is_empty(), "only whole words count");
    }

    #[test]
    fn reads_each_server_and_its_health() {
        let text = "Checking MCP server health…\n\n\
            claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected\n\
            claude.ai Microsoft 365: https://microsoft365.mcp.claude.com/mcp - ! Needs authentication\n\
            claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected\n\
            playwright: npx @playwright/mcp@latest - ✗ Failed to connect\n";
        assert_eq!(
            parse_mcp_list(text),
            vec![
                App { name: "Notion".into(), id: "claude_ai_Notion".into(), status: AppStatus::Connected },
                App { name: "Microsoft 365".into(), id: "claude_ai_Microsoft_365".into(), status: AppStatus::NeedsAuth },
                App { name: "Google Drive".into(), id: "claude_ai_Google_Drive".into(), status: AppStatus::Connected },
                App { name: "playwright".into(), id: "playwright".into(), status: AppStatus::Failed },
            ]
        );
    }

    #[test]
    fn has_nothing_to_say_about_other_lines() {
        assert!(parse_mcp_list("No MCP servers configured. Use `claude mcp add` to add a server.").is_empty());
    }

    #[test]
    fn matches_tools_to_their_app() {
        assert_eq!(app_of_tool("mcp__claude_ai_Notion__notion-create-pages"), Some("claude_ai_Notion"));
        assert_eq!(app_of_tool("mcp__claude_ai_Google_Drive__create_file"), Some(server_id("claude.ai Google Drive").as_str()));
        assert_eq!(app_of_tool("Bash"), None);
    }
}
