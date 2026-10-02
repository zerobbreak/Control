//! Headless mode.
//!
//! - `backend` prints a summary of every recent Claude Code and Gemini CLI session.
//! - `backend --follow` streams every event as JSON.
//! - `backend run "<goal>" [--in <folder>]` routes the goal, starts an agent on it and follows
//!   that run until the agent exits, asking on the terminal whenever the agent needs permission.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mission_control::{
    Answer, Board, ClaudeCode, EventKind, Orchestrator, RunStatus, RuntimeConfig, TranscriptWatcher, WatcherConfig,
};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = WatcherConfig::from_home().expect("could not find the home directory");
    if args.first().map(String::as_str) == Some("run") {
        run(config, &args[1..]);
    } else {
        watch(config, args.iter().any(|arg| arg == "--follow"));
    }
}

fn watch(config: WatcherConfig, follow: bool) {
    let mut watcher = TranscriptWatcher::new(config);
    let mut board = Board::default();
    loop {
        for event in watcher.poll() {
            if follow {
                println!("{}", serde_json::to_string(&event).unwrap_or_default());
            }
            board.apply(event);
        }
        if !follow {
            for s in board.snapshot(chrono::Utc::now()).sessions {
                println!(
                    "{:?}\t{:?}\t{}\t{}\t{}",
                    s.agent,
                    s.status,
                    s.title.as_deref().unwrap_or("(untitled)"),
                    s.project.as_deref().unwrap_or("?"),
                    s.current_activity.as_deref().unwrap_or("-"),
                );
            }
            return;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn run(config: WatcherConfig, args: &[String]) {
    let mut goal = None;
    let mut folder = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--in" => folder = rest.next().map(PathBuf::from),
            _ => goal = Some(arg.clone()),
        }
    }
    let Some(goal) = goal else {
        eprintln!("usage: backend run \"<goal>\" [--in <folder>]");
        std::process::exit(2);
    };

    let runtime = RuntimeConfig::from_home().expect("could not find the home directory");
    let mut orchestrator = Orchestrator::new(runtime, vec![Arc::new(ClaudeCode)]);
    let run = match orchestrator.start(&goal, folder.as_deref()) {
        Ok(run) => run,
        Err(err) => {
            eprintln!("not started: {err}");
            std::process::exit(1);
        }
    };
    println!("{:?} task → {:?} · {} · {:?}", run.decision.task, run.agent, run.model, run.decision.access);
    println!("why: {}", run.decision.reason);
    println!("in:  {}", run.workdir);
    println!("log: {}\n", run.log_path);

    // The agent's transcript appears under the run's ID; print what it does as it happens.
    let mut watcher = TranscriptWatcher::new(config);
    let _ = watcher.poll(); // skip history from other sessions
    loop {
        orchestrator.poll();
        for event in watcher.poll().into_iter().filter(|e| e.session_id == run.id) {
            match event.kind {
                EventKind::ToolCall { tool, summary } => println!("  {tool} · {summary}"),
                EventKind::ToolResult { is_error: true } => println!("    ✗ failed"),
                EventKind::AssistantText { text, .. } => println!("\n{text}\n"),
                _ => {}
            }
        }
        for approval in orchestrator.approvals() {
            let request = &approval.request;
            if let Some(description) = &request.description {
                println!("\n  {:?} wants to: {description}", approval.agent);
            }
            print!("  Allow {} · {}? [y/N] ", request.tool, request.detail);
            let _ = std::io::stdout().flush();
            let mut reply = String::new();
            let _ = std::io::stdin().read_line(&mut reply);
            let answer = if reply.trim().eq_ignore_ascii_case("y") {
                Answer::Allow
            } else {
                Answer::Deny("The user denied this in Mission Control.".into())
            };
            orchestrator.answer(&approval.run_id, &request.request_id, answer);
        }
        let status = orchestrator.runs()[0].status;
        if !matches!(status, RunStatus::Running | RunStatus::NeedsApproval) {
            let run = &orchestrator.runs()[0];
            println!("{status:?} (exit code {:?})", run.exit_code);
            std::process::exit(if status == RunStatus::Finished { 0 } else { 1 });
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}
