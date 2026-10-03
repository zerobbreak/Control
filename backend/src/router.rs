//! Decides what kind of work a goal is, how strong a model it needs and what the run may touch.
//!
//! These are plain rules for now. Once runs record whether they succeeded, the same `Decision`
//! can be informed by that history instead.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    /// Change code or files in a folder.
    Code,
    /// Answer something about a folder without changing it.
    Question,
    /// Do something in a web browser.
    Browse,
    /// Work with documents and apps such as Notion or Gmail, rather than code.
    Assistant,
}

/// How capable (and slow, and costly) a model the task deserves, weakest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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
    /// Read local files and act in connected apps, asking before anything that creates,
    /// changes or sends. Never changes local files.
    UseApps,
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

/// What came with the goal, which changes what kind of work it is.
#[derive(Debug, Clone, Copy, Default)]
pub struct Context {
    /// The goal is about a particular folder, usually a project.
    pub folder: bool,
    /// The user handed over files with the goal, such as a dropped PDF.
    pub attachments: bool,
}

/// "Open YouTube…" is a browser task; "fix the login and test it in the browser" is code work.
const BROWSE_START: [&str; 5] = ["open ", "go to ", "play ", "search ", "watch "];
const WEB: [&str; 5] = ["youtube", "browser", "website", "chrome", ".com"];
const QUESTION_START: [&str; 9] = ["what", "which", "where", "why", "how", "who", "is ", "are ", "does "];
const HARD: [&str; 7] = ["architect", "design", "refactor", "investigate", "debug", "migrate", "rewrite"];
const SMALL: [&str; 6] = ["typo", "rename", "small", "quick", "one line", "comment"];
/// Apps the assistant works in through claude.ai connectors.
const APPS: [&str; 8] = ["notion", "gmail", "email", "e-mail", "inbox", "calendar", "google drive", "my drive"];
/// Long goals usually describe several steps.
const LONG_GOAL_CHARS: usize = 400;

pub fn route(goal: &str, context: Context) -> Decision {
    let text = goal.trim().to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| text.contains(w));
    let question = QUESTION_START.iter().any(|w| text.starts_with(w)) || text.ends_with('?');

    if text.contains("youtube") || (BROWSE_START.iter().any(|w| text.starts_with(w)) && has(&WEB)) {
        return Decision {
            task: TaskKind::Browse,
            tier: Tier::Fast,
            access: Access::ReadOnly,
            reason: "A browser action.".into(),
        };
    }
    // In a project folder, "add Notion sync" is code work; outside one it is an errand in Notion.
    let mentions_app = has(&APPS);
    if !context.folder && (mentions_app || context.attachments) {
        return Decision {
            task: TaskKind::Assistant,
            tier: if question && !mentions_app { Tier::Fast } else { Tier::Balanced },
            access: Access::UseApps,
            reason: if mentions_app {
                "Work in your apps, so the assistant: it reads what you give it and asks before creating or sending anything."
            } else {
                "About the files you handed over, so the assistant: it reads them and changes nothing on this computer."
            }
            .into(),
        };
    }
    if question {
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

    fn route(goal: &str) -> Decision {
        super::route(goal, Context::default())
    }

    const IN_PROJECT: Context = Context { folder: true, attachments: false };
    const WITH_FILES: Context = Context { folder: false, attachments: true };

    #[test]
    fn errands_in_apps_and_dropped_files_go_to_the_assistant() {
        let d = route("Create a Notion page for this assignment");
        assert_eq!((d.task, d.tier, d.access), (TaskKind::Assistant, Tier::Balanced, Access::UseApps));
        assert_eq!(route("Email the summary to my lecturer").task, TaskKind::Assistant);
        assert_eq!(super::route("Summarise this", WITH_FILES).task, TaskKind::Assistant);
        assert_eq!(super::route("What is due first?", WITH_FILES).tier, Tier::Fast);
    }

    #[test]
    fn apps_named_inside_a_project_are_code_work() {
        assert_eq!(super::route("Add Notion sync to the backend", IN_PROJECT).task, TaskKind::Code);
        assert_eq!(super::route("Add a logout button", IN_PROJECT).task, TaskKind::Code);
    }

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
