//! Finds Claude Code and Gemini CLI transcript files and tails them for new lines.
//!
//! Polling instead of filesystem notifications keeps this reliable on Windows and on
//! synced folders such as OneDrive, and costs little at a one-second interval.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::claude;
use crate::events::AgentEvent;
use crate::gemini::GeminiParser;

pub struct WatcherConfig {
    pub claude_projects_dir: PathBuf,
    pub gemini_tmp_dir: PathBuf,
    /// Transcripts untouched for longer than this are ignored when first discovered.
    pub lookback: Duration,
}

impl WatcherConfig {
    pub fn from_home() -> Option<Self> {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
        let home = PathBuf::from(home);
        Some(Self {
            claude_projects_dir: home.join(".claude").join("projects"),
            gemini_tmp_dir: home.join(".gemini").join("tmp"),
            lookback: Duration::from_secs(48 * 60 * 60),
        })
    }
}

enum Parser {
    Claude,
    Gemini(GeminiParser),
}

struct TailedFile {
    offset: u64,
    partial: Vec<u8>,
    parser: Parser,
}

pub struct TranscriptWatcher {
    config: WatcherConfig,
    files: HashMap<PathBuf, TailedFile>,
    /// When set, only these Claude Code sessions are read; every other transcript is left alone.
    only_sessions: Option<HashSet<String>>,
}

impl TranscriptWatcher {
    pub fn new(config: WatcherConfig) -> Self {
        Self { config, files: HashMap::new(), only_sessions: None }
    }

    /// Limits reading to the given session IDs, or lifts the limit with `None`. Transcripts
    /// outside the limit are dropped, so none of their contents are read from then on.
    pub fn restrict_to(&mut self, sessions: Option<HashSet<String>>) {
        if let Some(allowed) = &sessions {
            self.files.retain(|path, _| session_of(path).is_some_and(|id| allowed.contains(&id)));
        }
        self.only_sessions = sessions;
    }

    fn wanted(&self, path: &Path) -> bool {
        match &self.only_sessions {
            None => true,
            Some(allowed) => session_of(path).is_some_and(|id| allowed.contains(&id)),
        }
    }

    /// Discovers new transcripts and returns every event written since the last poll.
    /// The first poll replays recent history so the board starts populated.
    pub fn poll(&mut self) -> Vec<AgentEvent> {
        self.discover();
        let mut events = Vec::new();
        for (path, file) in &mut self.files {
            if let Err(err) = read_new_lines(path, file, &mut events) {
                eprintln!("mission-control: failed to read {}: {err}", path.display());
            }
        }
        events.sort_by_key(|e| e.timestamp);
        events
    }

    fn discover(&mut self) {
        let cutoff = SystemTime::now() - self.config.lookback;
        let recent = |path: &Path| {
            fs::metadata(path)
                .and_then(|m| m.modified())
                .is_ok_and(|modified| modified >= cutoff)
        };

        // ~/.claude/projects/<project>/<session>.jsonl
        for project in subdirs(&self.config.claude_projects_dir) {
            for path in jsonl_files(&project) {
                if !self.files.contains_key(&path) && recent(&path) && self.wanted(&path) {
                    self.files.insert(path, TailedFile::new(Parser::Claude));
                }
            }
        }

        // Mission Control does not start Gemini yet, so a restricted watcher reads none of it.
        if self.only_sessions.is_some() {
            return;
        }

        // ~/.gemini/tmp/<project>/chats/session-*.jsonl, with the real path in <project>/.project_root
        for project in subdirs(&self.config.gemini_tmp_dir) {
            for path in jsonl_files(&project.join("chats")) {
                if self.files.contains_key(&path) || !recent(&path) {
                    continue;
                }
                let root = fs::read_to_string(project.join(".project_root"))
                    .ok()
                    .map(|s| s.trim().to_string());
                let session_id = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let parser = Parser::Gemini(GeminiParser::new(session_id, root));
                self.files.insert(path, TailedFile::new(parser));
            }
        }
    }
}

impl TailedFile {
    fn new(parser: Parser) -> Self {
        Self { offset: 0, partial: Vec::new(), parser }
    }
}

fn read_new_lines(
    path: &Path,
    file: &mut TailedFile,
    events: &mut Vec<AgentEvent>,
) -> std::io::Result<()> {
    let len = fs::metadata(path)?.len();
    if len < file.offset {
        // The transcript was rewritten; start over.
        file.offset = 0;
        file.partial.clear();
        if let Parser::Gemini(parser) = &mut file.parser {
            parser.reset();
        }
    }
    if len == file.offset {
        return Ok(());
    }

    let mut handle = File::open(path)?;
    handle.seek(SeekFrom::Start(file.offset))?;
    let mut buf = Vec::with_capacity((len - file.offset) as usize);
    handle.read_to_end(&mut buf)?;
    file.offset += buf.len() as u64;
    file.partial.extend_from_slice(&buf);

    // Only parse complete lines; keep a trailing half-written line for the next poll.
    let Some(last_newline) = file.partial.iter().rposition(|&b| b == b'\n') else {
        return Ok(());
    };
    let complete: Vec<u8> = file.partial.drain(..=last_newline).collect();
    for line in String::from_utf8_lossy(&complete).lines() {
        if line.trim().is_empty() {
            continue;
        }
        match &mut file.parser {
            Parser::Claude => events.extend(claude::parse_line(line)),
            Parser::Gemini(parser) => events.extend(parser.parse_line(line)),
        }
    }
    Ok(())
}

/// Claude Code names each transcript after its session ID.
fn session_of(path: &Path) -> Option<String> {
    path.file_stem().map(|stem| stem.to_string_lossy().into_owned())
}

fn subdirs(dir: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
}

fn jsonl_files(dir: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(session: &str) -> String {
        format!(r#"{{"type":"user","sessionId":"{session}","message":{{"content":"hello"}}}}"#) + "\n"
    }

    #[test]
    fn a_restricted_watcher_reads_only_the_sessions_it_is_given() {
        let root = std::env::temp_dir().join(format!("mc-watch-{}", uuid::Uuid::new_v4()));
        let project = root.join("claude").join("some-project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("mine.jsonl"), prompt("mine")).unwrap();
        fs::write(project.join("theirs.jsonl"), prompt("theirs")).unwrap();
        let config = WatcherConfig {
            claude_projects_dir: root.join("claude"),
            gemini_tmp_dir: root.join("gemini"),
            lookback: Duration::from_secs(3600),
        };

        let mut watcher = TranscriptWatcher::new(config);
        watcher.restrict_to(Some(HashSet::from(["mine".to_string()])));
        let sessions: Vec<_> = watcher.poll().into_iter().map(|e| e.session_id).collect();
        assert_eq!(sessions, ["mine"]);

        watcher.restrict_to(None);
        let sessions: Vec<_> = watcher.poll().into_iter().map(|e| e.session_id).collect();
        assert_eq!(sessions, ["theirs"], "lifting the limit picks up the other transcript");
        let _ = fs::remove_dir_all(root);
    }
}
