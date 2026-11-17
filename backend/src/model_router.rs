//! Routes a goal by asking a model which agent it is for, so "play J. Cole" reaches the browser and
//! "fix the login" reaches the coding agent however it is phrased. With a TypeSafe key set, Jev
//! answers first in a fraction of a second; when it is unsure or unreachable, a fast language
//! model is asked; when that cannot answer in time either, the keyword router decides. Models only
//! name the task, tier and reason: what each task may touch stays a fixed rule here, and the
//! user's limits apply afterwards as for any decision.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::jev;
use crate::orchestrator::{keyword_route, route_context};
use crate::router::{Access, Context, Decision, TaskKind, Tier};

const MODEL: &str = "haiku";
/// Past this the user is left staring at "Planning…"; the keyword router answers instead.
const TIMEOUT: Duration = Duration::from_secs(20);
/// Goals are usually planned and then started, so the second ask is answered from here.
const CACHE_SIZE: usize = 32;

const SYSTEM_PROMPT: &str = "You route one goal for Mission Control, a personal assistant on the user's computer, to one agent:
- code: change code or files in a software project (fix, build, refactor, write tests, commit).
- question: answer a question about the software project the user handed over, without changing it.
- browse: do something in the user's Chrome: play music or videos, open a site, search the web, watch something.
- assistant: personal errands and questions: email, calendar, Notion, documents and files the user dropped, planning, writing, general questions.
Personal goals are never code: \"play jcole\" is browse, \"what's due this week\" is assistant.
Only choose code or question when the goal is clearly about software; a handed-over project folder makes that likely but not certain.
Tier: fast for quick or simple goals, balanced for typical ones, strongest for broad, open-ended or architectural work.
Reason: one short sentence to the user on why, in plain words.";

const SCHEMA: &str = r#"{"type":"object","properties":{"task":{"type":"string","enum":["code","question","browse","assistant"]},"tier":{"type":"string","enum":["fast","balanced","strongest"]},"reason":{"type":"string"}},"required":["task","tier","reason"],"additionalProperties":false}"#;

#[derive(Debug, Deserialize, PartialEq)]
struct Answer {
    task: TaskKind,
    tier: Tier,
    reason: String,
}

/// Remembers recent answers so a reviewed plan and the run it starts agree.
#[derive(Default)]
pub struct ModelRouter {
    cache: Mutex<Vec<(String, Decision)>>,
}

impl ModelRouter {
    /// The decision for `goal`. Blocks while the model answers, for a few seconds: call it off
    /// the UI thread and without holding the orchestrator.
    pub fn route(&self, goal: &str, folder: Option<&Path>, attachments: &[PathBuf]) -> Decision {
        let context = route_context(folder, attachments);
        let fallback = keyword_route(goal, folder, attachments);
        // A dropped folder that isn't a project gets the assistant's read-only scan; there is
        // nothing for the model to decide.
        if goal.trim().is_empty() || (!context.folder && context.loose_folder) {
            return fallback;
        }
        let key = cache_key(goal, folder, attachments);
        if let Some(hit) = self.cache.lock().unwrap().iter().find(|(k, _)| *k == key) {
            return hit.1.clone();
        }
        let message = message(goal, folder, attachments);
        let decision = jev::api_key()
            .and_then(|key| jev::classify(&key, &message))
            .filter(|choice| choice.confidence >= jev::CONFIDENT)
            .map(|choice| {
                let mut decision = shape(Answer { task: choice.task, tier: choice.tier, reason: String::new() }, context);
                // After shaping, since a question without a project becomes the assistant's.
                decision.reason = jev::reason(decision.task).to_string();
                decision
            })
            .or_else(|| ask(&message).and_then(|out| parse(&out)).map(|answer| shape(answer, context)))
            .unwrap_or(fallback);
        let mut cache = self.cache.lock().unwrap();
        cache.retain(|(k, _)| *k != key);
        cache.push((key, decision.clone()));
        if cache.len() > CACHE_SIZE {
            cache.remove(0);
        }
        decision
    }
}

fn cache_key(goal: &str, folder: Option<&Path>, attachments: &[PathBuf]) -> String {
    let mut key = goal.trim().to_lowercase();
    for path in folder.into_iter().chain(attachments.iter().map(PathBuf::as_path)) {
        key.push('\n');
        key.push_str(&path.display().to_string());
    }
    key
}

/// What the model is told: the goal and what came with it. File contents never leave here.
fn message(goal: &str, folder: Option<&Path>, attachments: &[PathBuf]) -> String {
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string());
    let mut text = format!("Goal: {}\n", goal.trim());
    match folder {
        Some(dir) => text.push_str(&format!("Handed-over project folder: {}\n", name(dir))),
        None => text.push_str("No project folder handed over.\n"),
    }
    if !attachments.is_empty() {
        let names: Vec<String> = attachments
            .iter()
            .map(|a| if a.is_dir() { format!("{} (folder)", name(a)) } else { name(a) })
            .collect();
        text.push_str(&format!("Handed-over files: {}\n", names.join(", ")));
    }
    text
}

/// Runs the model with no tools, no MCP servers and no saved session, so it only answers and
/// leaves nothing for the transcript watcher to pick up.
fn ask(message: &str) -> Option<String> {
    let mut cmd = Command::new("claude");
    cmd.args(["--print", "--model", MODEL, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence"])
        .args(["--json-schema", SCHEMA, "--system-prompt", SYSTEM_PROMPT])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    child.stdin.take()?.write_all(message.as_bytes()).ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        stdout.read_to_string(&mut out).map(|_| out)
    });
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    reader.join().ok()?.ok()
}

/// Reads the structured answer out of `claude --output-format json`.
fn parse(output: &str) -> Option<Answer> {
    let value: serde_json::Value = serde_json::from_str(output.trim()).ok()?;
    if value.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
        return None;
    }
    let answer = match value.get("structured_output") {
        Some(structured) if !structured.is_null() => structured.clone(),
        // Older CLIs put the JSON text in `result`.
        _ => serde_json::from_str(value.get("result")?.as_str()?).ok()?,
    };
    let answer: Answer = serde_json::from_value(answer).ok()?;
    (!answer.reason.trim().is_empty()).then_some(answer)
}

/// Turns the model's choice into a decision with the access that task always has.
fn shape(answer: Answer, context: Context) -> Decision {
    let reason = answer.reason.trim().to_string();
    match answer.task {
        TaskKind::Code => Decision { task: TaskKind::Code, tier: answer.tier, access: Access::EditFiles, reason },
        // Without a project there is nothing to read: a question becomes the assistant's.
        TaskKind::Question if context.folder => Decision { task: TaskKind::Question, tier: answer.tier, access: Access::ReadOnly, reason },
        // The browser agent acts only in Chrome, so a fast model is always enough.
        TaskKind::Browse => Decision { task: TaskKind::Browse, tier: Tier::Fast, access: Access::ReadOnly, reason },
        // The fast model cannot hold the connected apps' tools, so the assistant gets at least balanced.
        TaskKind::Question | TaskKind::Assistant => {
            Decision { task: TaskKind::Assistant, tier: answer.tier.max(Tier::Balanced), access: Access::UseApps, reason }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_FOLDER: Context = Context { folder: false, attachments: false, loose_folder: false };
    const IN_PROJECT: Context = Context { folder: true, attachments: false, loose_folder: false };

    fn answer(task: TaskKind, tier: Tier) -> Answer {
        Answer { task, tier, reason: "Because.".into() }
    }

    #[test]
    fn reads_the_structured_answer() {
        let out = r#"{"type":"result","is_error":false,"result":"","structured_output":{"task":"browse","tier":"fast","reason":"Music, so Chrome."}}"#;
        assert_eq!(parse(out), Some(Answer { task: TaskKind::Browse, tier: Tier::Fast, reason: "Music, so Chrome.".into() }));
        let older = r#"{"is_error":false,"result":"{\"task\":\"code\",\"tier\":\"balanced\",\"reason\":\"A bug.\"}"}"#;
        assert_eq!(parse(older).unwrap().task, TaskKind::Code);
    }

    #[test]
    fn falls_back_on_anything_else() {
        assert_eq!(parse("not json"), None);
        assert_eq!(parse(r#"{"is_error":true,"result":"rate limited"}"#), None);
        assert_eq!(parse(r#"{"structured_output":{"task":"dance","tier":"fast","reason":"x"}}"#), None);
        assert_eq!(parse(r#"{"structured_output":{"task":"code","tier":"fast","reason":" "}}"#), None);
    }

    #[test]
    fn each_task_keeps_its_fixed_access() {
        assert_eq!(shape(answer(TaskKind::Code, Tier::Balanced), IN_PROJECT).access, Access::EditFiles);
        let browse = shape(answer(TaskKind::Browse, Tier::Strongest), NO_FOLDER);
        assert_eq!((browse.tier, browse.access), (Tier::Fast, Access::ReadOnly));
        let errand = shape(answer(TaskKind::Assistant, Tier::Fast), NO_FOLDER);
        assert_eq!((errand.tier, errand.access), (Tier::Balanced, Access::UseApps));
    }

    #[test]
    fn a_question_without_a_project_goes_to_the_assistant() {
        assert_eq!(shape(answer(TaskKind::Question, Tier::Fast), IN_PROJECT).task, TaskKind::Question);
        assert_eq!(shape(answer(TaskKind::Question, Tier::Fast), NO_FOLDER).task, TaskKind::Assistant);
    }

    #[test]
    fn tells_the_model_only_names() {
        let text = message("  Summarise this  ", Some(Path::new("C:/dev/Lumina")), &[PathBuf::from("C:/Users/me/brief.pdf")]);
        assert_eq!(text, "Goal: Summarise this\nHanded-over project folder: Lumina\nHanded-over files: brief.pdf\n");
        assert!(message("play jcole", None, &[]).contains("No project folder"));
    }

    #[test]
    fn cached_by_goal_and_context() {
        assert_eq!(cache_key("Play JCole ", None, &[]), cache_key("play jcole", None, &[]));
        assert_ne!(cache_key("fix it", Some(Path::new("a")), &[]), cache_key("fix it", Some(Path::new("b")), &[]));
    }

    /// Calls the real model: `cargo test -p backend -- --ignored routes_with_the_real_model`.
    #[test]
    #[ignore]
    fn routes_with_the_real_model() {
        let router = ModelRouter::default();
        assert_eq!(router.route("play jcole", None, &[]).task, TaskKind::Browse);
        assert_eq!(router.route("throw on some kendrick", None, &[]).task, TaskKind::Browse);
        assert_eq!(router.route("what do I have on this week?", None, &[]).task, TaskKind::Assistant);
        let project = std::env::temp_dir();
        assert_eq!(router.route("the login page is broken, sort it out", Some(&project), &[]).task, TaskKind::Code);
    }
}
