//! Jev, TypeSafe AI's hosted decision model: given a goal, it picks the agent with a calibrated
//! confidence in about a tenth of a second, where a language model takes several seconds. It is
//! optional and opt-in: it runs only when the user has set a TypeSafe API key, and anything it is
//! unsure about falls through to the model router's language model.
//! API: https://docs.typesafe.ai/api.md

use std::time::Duration;

use serde_json::{Value, json};

use crate::router::{TaskKind, Tier};

/// Where the key is read from; TypeSafe's docs use the same name.
pub const KEY_VAR: &str = "TYPESAFE_API_KEY";
const URL: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-latest";
/// Answers usually take well under a second; past this the language model is quicker to ask.
const TIMEOUT: Duration = Duration::from_secs(3);
/// TypeSafe suggests acting on its own above about 0.9 and confirming below.
/// https://docs.typesafe.ai/confidence.md
pub const CONFIDENT: f64 = 0.9;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Choice {
    pub task: TaskKind,
    /// How sure Jev is of the task, from 0 (evenly spread) to 1 (certain).
    pub confidence: f64,
    pub tier: Tier,
}

/// The user's TypeSafe key, if they have set one. A key saved as a user variable after the app
/// started is not in its environment yet, so Windows' saved user variables are checked too.
pub fn api_key() -> Option<String> {
    std::env::var(KEY_VAR).ok().or_else(saved_user_variable).map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

#[cfg(windows)]
fn saved_user_variable() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("reg")
        .args(["query", r"HKCU\Environment", "/v", KEY_VAR])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // "    TYPESAFE_API_KEY    REG_SZ    apikey_…"
    text.lines().find_map(|line| line.trim().strip_prefix(KEY_VAR)?.trim().strip_prefix("REG_SZ").map(|v| v.trim().to_string()))
}

#[cfg(not(windows))]
fn saved_user_variable() -> Option<String> {
    None
}

/// Asks Jev which agent `message` (the router's description of the goal) is for. None on any
/// failure: no network, a bad key, rate limits or an answer that doesn't parse.
pub fn classify(key: &str, message: &str) -> Option<Choice> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(TIMEOUT)).build().into();
    let mut response = agent.post(URL).header("Authorization", &format!("Bearer {key}")).send_json(request(message)).ok()?;
    parse(&response.body_mut().read_json::<Value>().ok()?)
}

/// One choice question for the agent and one score question for how much work it is. The
/// criteria say what each agent is for, and that personal goals are never code.
fn request(message: &str) -> Value {
    json!({
        "model": MODEL,
        "state": message,
        "questions": {
            "task": {
                "type": "choice",
                "instructions": "Which of Mission Control's agents should do this goal for the user",
                "criteria": {
                    "code": {
                        "what": "Change code or files in a software project: fix, build, refactor, write tests, commit",
                        "not_for": "Personal goals such as music, videos, errands or general questions, even with a project folder handed over",
                        "examples": ["Fix the login bug", "Add a logout button to the header", "The login page is broken, sort it out"]
                    },
                    "question": {
                        "what": "Answer a question about the handed-over software project without changing it",
                        "not_for": "General or personal questions that are not about the project's code",
                        "examples": ["Which file in this repo is the largest?", "How does the auth middleware work?"]
                    },
                    "browse": {
                        "what": "Do something in the user's Chrome: play music or videos, open a site, search the web",
                        "not_for": "Changing code or files",
                        "examples": ["play jcole", "throw on some kendrick", "Open YouTube", "Search for flights to Cape Town"]
                    },
                    "assistant": {
                        "what": "Personal errands and questions: email, calendar, Notion, documents and files the user dropped, planning, writing",
                        "not_for": "Changing code in a software project",
                        "examples": ["What's due this week?", "Summarise this PDF", "Reply to my lecturer's email", "Plan my week"]
                    }
                }
            },
            "tier": {
                "type": "score",
                "instructions": "How much work this goal is",
                "criteria": ["Quick or simple", "Typical", "Broad, open-ended or architectural"]
            }
        }
    })
}

fn parse(response: &Value) -> Option<Choice> {
    let answers = response.get("answers")?;
    let task = answers.get("task")?;
    let task_kind = match task.get("choice")?.as_str()? {
        "code" => TaskKind::Code,
        "question" => TaskKind::Question,
        "browse" => TaskKind::Browse,
        "assistant" => TaskKind::Assistant,
        _ => return None,
    };
    let confidence = task.get("confidence")?.as_f64()?;
    // The score is probability-weighted, e.g. 1.2 between "quick" (0) and "typical" (1).
    let tier = match answers.get("tier").and_then(|t| t.get("score")).and_then(Value::as_f64).map(f64::round) {
        Some(s) if s < 0.5 => Tier::Fast,
        Some(s) if s >= 1.5 => Tier::Strongest,
        _ => Tier::Balanced,
    };
    Some(Choice { task: task_kind, confidence, tier })
}

/// Jev picks but does not explain, so each agent gets a fixed reason.
pub fn reason(task: TaskKind) -> &'static str {
    match task {
        TaskKind::Code => "Work on a software project, so the coding agent.",
        TaskKind::Question => "A question about this project, so an agent that reads it without changing anything.",
        TaskKind::Browse => "Something to play or open, so the browser agent does it in Chrome.",
        TaskKind::Assistant => "A personal errand or question, so the assistant: it asks before creating or sending anything.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real answer from jev-1.13.0 for "play jcole".
    const ANSWER: &str = r#"{"model":"jev-1.13.0","answers":{"task":{"type":"choice","choice":"browse","confidence":1.0,"probabilities":{"question":0.0,"assistant":0.0,"browse":1.0,"code":0.0}},"tier":{"type":"score","score":1.2,"confidence":0.0,"legend":{"0":"Quick or simple","1":"Typical","2":"Broad, open-ended or architectural"},"probabilities":{"0":0.33,"1":0.14,"2":0.53}}},"usage":{"input_tokens":623,"output_tokens":59}}"#;

    #[test]
    fn reads_the_choice_confidence_and_tier() {
        let value: Value = serde_json::from_str(ANSWER).unwrap();
        assert_eq!(parse(&value), Some(Choice { task: TaskKind::Browse, confidence: 1.0, tier: Tier::Balanced }));
    }

    #[test]
    fn rounds_the_score_to_a_tier() {
        let with = |score: f64| json!({"answers": {"task": {"choice": "code", "confidence": 0.95}, "tier": {"score": score}}});
        assert_eq!(parse(&with(0.3)).unwrap().tier, Tier::Fast);
        assert_eq!(parse(&with(1.49)).unwrap().tier, Tier::Balanced);
        assert_eq!(parse(&with(1.7)).unwrap().tier, Tier::Strongest);
        let no_tier = json!({"answers": {"task": {"choice": "code", "confidence": 0.95}}});
        assert_eq!(parse(&no_tier).unwrap().tier, Tier::Balanced);
    }

    #[test]
    fn rejects_anything_else() {
        assert_eq!(parse(&json!({"error": "invalid key"})), None);
        assert_eq!(parse(&json!({"answers": {"task": {"choice": "dance", "confidence": 1.0}}})), None);
        assert_eq!(parse(&json!({"answers": {"task": {"choice": "code"}}})), None);
    }

    #[test]
    fn sends_the_routers_message_and_all_four_agents() {
        let body = request("Goal: play jcole\n");
        assert_eq!(body["state"], "Goal: play jcole\n");
        let criteria = body["questions"]["task"]["criteria"].as_object().unwrap();
        assert_eq!(criteria.len(), 4);
        assert!(["code", "question", "browse", "assistant"].iter().all(|k| criteria.contains_key(*k)));
        assert_eq!(body["questions"]["tier"]["criteria"].as_array().unwrap().len(), 3);
    }

    /// Calls the real service with your key: `cargo test -p backend -- --ignored jev_routes`.
    #[test]
    #[ignore]
    fn jev_routes_personal_and_work_goals() {
        let key = api_key().expect("set TYPESAFE_API_KEY");
        let task = |message: &str| classify(&key, message).expect("Jev answered").task;
        assert_eq!(task("Goal: play jcole\nNo project folder handed over.\n"), TaskKind::Browse);
        assert_eq!(task("Goal: throw on some kendrick\nNo project folder handed over.\n"), TaskKind::Browse);
        assert_eq!(task("Goal: what do I have on this week?\nNo project folder handed over.\n"), TaskKind::Assistant);
        assert_eq!(task("Goal: the login page is broken, sort it out\nHanded-over project folder: Lumina\n"), TaskKind::Code);
    }
}
