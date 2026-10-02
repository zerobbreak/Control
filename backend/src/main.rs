//! Headless mode: prints a live summary of every Claude Code and Gemini CLI session.

use std::time::Duration;

use mission_control::{Board, TranscriptWatcher, WatcherConfig};

fn main() {
    let config = WatcherConfig::from_home().expect("could not find the home directory");
    let mut watcher = TranscriptWatcher::new(config);
    let mut board = Board::default();
    let follow = std::env::args().any(|arg| arg == "--follow");

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
