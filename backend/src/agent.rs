//! Agents Mission Control can start. Each one turns a routed goal into a command line, so other
//! CLIs can sit beside Claude Code without the orchestrator knowing their flags.

use std::path::Path;
use std::process::Command;

use crate::events::AgentKind;
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

pub trait Agent: Send {
    fn kind(&self) -> AgentKind;
    fn handles(&self, task: TaskKind) -> bool;
    /// The model this agent uses for a tier, as its CLI names it.
    fn model(&self, tier: Tier) -> &'static str;
    /// The command that runs `launch` to completion without a terminal.
    fn command(&self, launch: &Launch) -> Command;
}

/// Claude Code in print mode: one goal, worked through without an interactive session.
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
        // Print mode cannot show permission prompts, so the access level decides up front what
        // the run may do: answering questions stays read-only, code work may edit files.
        let permission_mode = match launch.access {
            Access::ReadOnly => "plan",
            Access::EditFiles => "acceptEdits",
        };
        let mut cmd = Command::new("claude");
        cmd.current_dir(launch.workdir)
            .arg("--print")
            .arg(launch.goal)
            .args(["--model", self.model(launch.tier)])
            .args(["--session-id", launch.session_id])
            .args(["--permission-mode", permission_mode])
            .args(["--name", &crate::events::truncate(launch.goal, 60)]);
        cmd
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_command_carries_model_session_and_access() {
        let launch = Launch {
            session_id: "0b6f3c2e-0000-4000-8000-000000000000",
            goal: "fix the login",
            workdir: Path::new("."),
            tier: Tier::Strongest,
            access: Access::ReadOnly,
        };
        let cmd = ClaudeCode.command(&launch);
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(cmd.get_program(), "claude");
        assert_eq!(
            args,
            [
                "--print",
                "fix the login",
                "--model",
                "opus",
                "--session-id",
                "0b6f3c2e-0000-4000-8000-000000000000",
                "--permission-mode",
                "plan",
                "--name",
                "fix the login",
            ]
        );
    }
}
