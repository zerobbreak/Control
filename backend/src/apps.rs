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
