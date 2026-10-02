//! Decides what kind of work a goal is, how strong a model it needs and what the run may touch.
//!
//! These are plain rules for now. Once runs record whether they succeeded, the same `Decision`
//! can be informed by that history instead.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    /// Change code or files in a folder.
    Code,
    /// Answer something about a folder without changing it.
    Question,
    /// Do something in a web browser.
    Browse,
}

/// How capable (and slow, and costly) a model the task deserves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    Fast,
    Balanced,
    Strongest,
}

/// What a run is allowed to do on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    ReadOnly,
    EditFiles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub task: TaskKind,
    pub tier: Tier,
    pub access: Access,
    /// One line on why, for the person approving the run.
    pub reason: String,
}

/// "Open YouTube…" is a browser task; "fix the login and test it in the browser" is code work.
const BROWSE_START: [&str; 5] = ["open ", "go to ", "play ", "search ", "watch "];
const WEB: [&str; 5] = ["youtube", "browser", "website", "chrome", ".com"];
const QUESTION_START: [&str; 9] = ["what", "which", "where", "why", "how", "who", "is ", "are ", "does "];
const HARD: [&str; 7] = ["architect", "design", "refactor", "investigate", "debug", "migrate", "rewrite"];
const SMALL: [&str; 6] = ["typo", "rename", "small", "quick", "one line", "comment"];
/// Long goals usually describe several steps.
const LONG_GOAL_CHARS: usize = 400;

pub fn route(goal: &str) -> Decision {
    let text = goal.trim().to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| text.contains(w));

    if text.contains("youtube") || (BROWSE_START.iter().any(|w| text.starts_with(w)) && has(&WEB)) {
        return Decision {
            task: TaskKind::Browse,
            tier: Tier::Fast,
            access: Access::ReadOnly,
            reason: "A browser action.".into(),
        };
    }
    if QUESTION_START.iter().any(|w| text.starts_with(w)) || text.ends_with('?') {
        return Decision {
            task: TaskKind::Question,
            tier: if has(&HARD) { Tier::Balanced } else { Tier::Fast },
            access: Access::ReadOnly,
            reason: "A question, so the agent reads but does not change anything.".into(),
        };
    }
    let (tier, reason) = if has(&HARD) || text.len() > LONG_GOAL_CHARS {
        (Tier::Strongest, "Broad or open-ended code work, so the strongest model.")
    } else if has(&SMALL) {
        (Tier::Fast, "A small, contained change, so a fast model.")
    } else {
        (Tier::Balanced, "A typical code change.")
    };
    Decision { task: TaskKind::Code, tier, access: Access::EditFiles, reason: reason.into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn questions_are_read_only_and_fast() {
        let d = route("What's taking up the most space in this folder?");
        assert_eq!((d.task, d.tier, d.access), (TaskKind::Question, Tier::Fast, Access::ReadOnly));
    }

    #[test]
    fn code_work_scales_the_model_with_the_job() {
        assert_eq!(route("Fix the typo in the README").tier, Tier::Fast);
        assert_eq!(route("Add a logout button to the header").tier, Tier::Balanced);
        assert_eq!(route("Refactor the auth module into services").tier, Tier::Strongest);
        assert_eq!(route("Add a logout button").access, Access::EditFiles);
    }

    #[test]
    fn browser_actions_are_recognised() {
        assert_eq!(route("Open YouTube and play lofi beats").task, TaskKind::Browse);
        assert_eq!(route("Go to github.com and star the repo").task, TaskKind::Browse);
        assert_eq!(route("Fix the login and test it in the browser").task, TaskKind::Code);
        assert_eq!(route("Add a display name field").task, TaskKind::Code);
    }
}
