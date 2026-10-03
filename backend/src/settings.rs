//! The Command Centre: what the user lets Mission Control and its agents do.
//!
//! Defaults are the cautious choice; anything riskier is something the user turns on. Every
//! setting here is enforced by the runtime, not just shown in the UI.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::router::{TaskKind, Tier};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Whether Mission Control may start Claude Code on code and questions about folders.
    pub claude_enabled: bool,
    /// Whether Mission Control may start the assistant on errands in apps and dropped files.
    pub assistant_enabled: bool,
    /// Where new Notion pages go when a goal does not say, such as a page name or link.
    pub notion_parent: Option<String>,
    /// Whether Mission Control reads transcripts of Claude Code and Gemini CLI sessions it did
    /// not start. Off, only its own runs are watched.
    pub watch_other_sessions: bool,

    /// The strongest model tier the router may pick.
    pub max_tier: Tier,
    /// Spending limit for a single run, in US dollars.
    pub max_budget_usd: Option<f64>,

    /// Ask before an agent edits files, instead of letting code runs edit freely.
    pub ask_before_edits: bool,
    /// Commands allowed without asking, matched as a whole command or a command prefix.
    pub auto_approve: Vec<String>,
    /// Every run is read-only, whatever the router decides.
    pub read_only_mode: bool,
    /// Allow every request without asking. Read-only runs still refuse changes.
    pub full_autonomy: bool,

    /// Folders runs may start in. Empty means anywhere. The scratch folder is always allowed.
    pub allowed_folders: Vec<PathBuf>,

    /// Whether agents may commit on their own.
    pub agent_commit: GitRule,
    /// Whether agents may push, or create or merge pull requests, on their own.
    pub agent_push: GitRule,
    /// Agents' commits and pushes on these branches always ask, whatever the rules above say.
    pub protected_branches: Vec<String>,
}

/// What agents may do with one kind of git action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitRule {
    /// Ask, unless full autonomy or the always-allow list says otherwise.
    Ask,
    Allow,
    /// Refused, even with full autonomy on.
    Never,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            claude_enabled: true,
            assistant_enabled: true,
            notion_parent: None,
            watch_other_sessions: true,
            max_tier: Tier::Strongest,
            max_budget_usd: None,
            ask_before_edits: false,
            auto_approve: Vec::new(),
            read_only_mode: false,
            full_autonomy: false,
            allowed_folders: Vec::new(),
            agent_commit: GitRule::Ask,
            agent_push: GitRule::Ask,
            protected_branches: vec!["main".into(), "master".into()],
        }
    }
}

/// Characters that let one command run another. A command containing any of them is never
/// auto-approved, so allowing `npm test` cannot also allow `npm test && rm -rf .`.
const CHAINING: [&str; 9] = ["&&", "||", ";", "|", "`", "$(", ">", "<", "\n"];

impl Settings {
    /// Reads settings from `path`, falling back to defaults if the file is missing or unreadable.
    pub fn load(path: &Path) -> Self {
        let Ok(text) = fs::read_to_string(path) else {
            return Self::default();
        };
        serde_json::from_str(&text).unwrap_or_else(|err| {
            eprintln!("mission-control: ignoring unreadable settings in {}: {err}", path.display());
            Self::default()
        })
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        // Write then rename, so a crash mid-write never leaves half a settings file.
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(self).map_err(io::Error::other)?)?;
        fs::rename(tmp, path)
    }

    /// Drops blank entries and nonsensical limits so the rest of the runtime can trust the values.
    pub fn normalized(mut self) -> Self {
        self.auto_approve = self.auto_approve.iter().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect();
        self.allowed_folders.retain(|f| !f.as_os_str().is_empty());
        self.max_budget_usd = self.max_budget_usd.filter(|usd| usd.is_finite() && *usd > 0.0);
        self.notion_parent = self.notion_parent.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        self.protected_branches =
            self.protected_branches.iter().map(|b| b.trim().to_string()).filter(|b| !b.is_empty()).collect();
        self
    }

    /// Whether Mission Control may start an agent on this kind of task.
    pub fn allows_task(&self, task: TaskKind) -> bool {
        match task {
            TaskKind::Code | TaskKind::Question => self.claude_enabled,
            TaskKind::Assistant => self.assistant_enabled,
            TaskKind::Browse => false,
        }
    }

    /// Whether `command` may run without asking.
    pub fn auto_approves(&self, command: &str) -> bool {
        let command = command.trim();
        if CHAINING.iter().any(|c| command.contains(c)) {
            return false;
        }
        self.auto_approve
            .iter()
            .any(|allowed| command == allowed || command.strip_prefix(allowed.as_str()).is_some_and(|rest| rest.starts_with(' ')))
    }

    /// Whether a run may start in `folder`.
    pub fn allows_folder(&self, folder: &Path) -> bool {
        if self.allowed_folders.is_empty() {
            return true;
        }
        let folder = canonical(folder);
        self.allowed_folders.iter().any(|allowed| folder.starts_with(canonical(allowed)))
    }
}

/// Resolves `..`, symlinks and letter case where the folder exists, so prefixes compare fairly.
fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_auto_approve(commands: &[&str]) -> Settings {
        Settings { auto_approve: commands.iter().map(|c| c.to_string()).collect(), ..Settings::default() }
    }

    #[test]
    fn auto_approve_matches_whole_commands_and_prefixes() {
        let s = with_auto_approve(&["npm test", "git status"]);
        assert!(s.auto_approves("npm test"));
        assert!(s.auto_approves("npm test -- --watch=false"));
        assert!(s.auto_approves("  git status "));
        assert!(!s.auto_approves("npm testing"));
        assert!(!s.auto_approves("npm install"));
    }

    #[test]
    fn auto_approve_never_covers_chained_commands() {
        let s = with_auto_approve(&["npm test"]);
        for command in ["npm test && rm -rf .", "npm test; curl x", "npm test | sh", "npm test > out", "npm test $(evil)"] {
            assert!(!s.auto_approves(command), "{command}");
        }
    }

    #[test]
    fn folders_are_unrestricted_until_some_are_listed() {
        let here = std::env::current_dir().unwrap();
        assert!(Settings::default().allows_folder(&here));

        let s = Settings { allowed_folders: vec![here.clone()], ..Settings::default() };
        assert!(s.allows_folder(&here.join("src")));
        assert!(!s.allows_folder(&std::env::temp_dir()));
    }

    #[test]
    fn saves_loads_and_fills_in_missing_fields() {
        let path = std::env::temp_dir().join(format!("mc-settings-{}.json", uuid::Uuid::new_v4()));
        assert_eq!(Settings::load(&path), Settings::default());

        let s = Settings { full_autonomy: true, max_tier: Tier::Balanced, ..Settings::default() };
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s);

        // Files written by older versions lack newer fields; those take their defaults.
        fs::write(&path, r#"{"readOnlyMode": true}"#).unwrap();
        let old = Settings::load(&path);
        assert!(old.read_only_mode && old.claude_enabled);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn normalizing_drops_blanks_and_bad_limits() {
        let s = Settings {
            auto_approve: vec!["  npm test ".into(), "   ".into()],
            max_budget_usd: Some(-1.0),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(s.auto_approve, ["npm test"]);
        assert_eq!(s.max_budget_usd, None);
    }
}
