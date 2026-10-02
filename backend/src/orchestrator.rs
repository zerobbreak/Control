//! Turns a goal into a running agent: routes it, picks an agent that can do it, starts the
//! process and keeps track of it until it exits.
//!
//! Progress inside a run is not read here. Each run uses a session ID chosen up front, so the
//! transcript watcher reports its events under that same ID on the board.

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::agent::{Agent, Launch};
use crate::events::AgentKind;
use crate::router::{self, Decision};

pub struct RuntimeConfig {
    /// One log file per run, holding the agent's stdout and stderr.
    pub runs_dir: PathBuf,
    /// Where goals that are not about any folder run.
    pub scratch_dir: PathBuf,
}

impl RuntimeConfig {
    pub fn from_home() -> Option<Self> {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
        let root = PathBuf::from(home).join(".mission-control");
        Some(Self { runs_dir: root.join("runs"), scratch_dir: root.join("scratch") })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Running,
    Finished,
    Failed,
    Cancelled,
}

/// One goal handed to one agent, as the UI sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    /// Also the agent's session ID, so it matches a session on the board.
    pub id: String,
    pub goal: String,
    pub workdir: String,
    pub agent: AgentKind,
    pub model: String,
    pub decision: Decision,
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub log_path: String,
}

#[derive(Debug)]
pub enum StartError {
    EmptyGoal,
    MissingFolder(PathBuf),
    /// No registered agent can do this kind of task yet.
    NoAgent(Decision),
    Spawn(std::io::Error),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyGoal => write!(f, "the goal is empty"),
            Self::MissingFolder(path) => write!(f, "{} is not a folder", path.display()),
            Self::NoAgent(d) => write!(f, "no agent can handle {:?} tasks yet", d.task),
            Self::Spawn(err) => write!(f, "could not start the agent: {err}"),
        }
    }
}

impl std::error::Error for StartError {}

struct Run {
    summary: RunSummary,
    child: Option<Child>,
}

pub struct Orchestrator {
    config: RuntimeConfig,
    agents: Vec<Box<dyn Agent>>,
    runs: Vec<Run>,
}

impl Orchestrator {
    /// `agents` are tried in order; the first that handles a task gets it.
    pub fn new(config: RuntimeConfig, agents: Vec<Box<dyn Agent>>) -> Self {
        Self { config, agents, runs: Vec::new() }
    }

    /// Routes `goal`, starts an agent on it in `folder` (or the scratch folder) and returns the run.
    pub fn start(&mut self, goal: &str, folder: Option<&Path>) -> Result<RunSummary, StartError> {
        let goal = goal.trim();
        if goal.is_empty() {
            return Err(StartError::EmptyGoal);
        }
        let workdir = match folder {
            Some(dir) if dir.is_dir() => dir.to_path_buf(),
            Some(dir) => return Err(StartError::MissingFolder(dir.to_path_buf())),
            None => {
                fs::create_dir_all(&self.config.scratch_dir).map_err(StartError::Spawn)?;
                self.config.scratch_dir.clone()
            }
        };

        let decision = router::route(goal);
        let Some(agent) = self.agents.iter().find(|a| a.handles(decision.task)) else {
            return Err(StartError::NoAgent(decision));
        };

        let id = uuid::Uuid::new_v4().to_string();
        let launch = Launch { session_id: &id, goal, workdir: &workdir, tier: decision.tier, access: decision.access };
        fs::create_dir_all(&self.config.runs_dir).map_err(StartError::Spawn)?;
        let log_path = self.config.runs_dir.join(format!("{id}.log"));
        let child = spawn_logged(agent.command(&launch), &log_path).map_err(StartError::Spawn)?;

        let summary = RunSummary {
            id: id.clone(),
            goal: goal.to_string(),
            workdir: workdir.display().to_string(),
            agent: agent.kind(),
            model: agent.model(decision.tier).to_string(),
            decision,
            status: RunStatus::Running,
            exit_code: None,
            started_at: Utc::now(),
            ended_at: None,
            log_path: log_path.display().to_string(),
        };
        self.runs.push(Run { summary: summary.clone(), child: Some(child) });
        Ok(summary)
    }

    /// Stops a running run. Returns false if there is no such run or it already ended.
    pub fn cancel(&mut self, id: &str) -> bool {
        let Some(run) = self.runs.iter_mut().find(|r| r.summary.id == id) else {
            return false;
        };
        let Some(mut child) = run.child.take() else {
            return false;
        };
        let _ = child.kill();
        let _ = child.wait();
        run.summary.status = RunStatus::Cancelled;
        run.summary.ended_at = Some(Utc::now());
        true
    }

    /// Notices runs whose process has exited. Call it regularly; it never blocks.
    pub fn poll(&mut self) {
        for run in &mut self.runs {
            let Some(child) = &mut run.child else { continue };
            let status = match child.try_wait() {
                Ok(Some(status)) => status,
                Ok(None) => continue,
                Err(err) => {
                    eprintln!("mission-control: lost track of run {}: {err}", run.summary.id);
                    run.child = None;
                    run.summary.status = RunStatus::Failed;
                    run.summary.ended_at = Some(Utc::now());
                    continue;
                }
            };
            run.child = None;
            run.summary.exit_code = status.code();
            run.summary.status = if status.success() { RunStatus::Finished } else { RunStatus::Failed };
            run.summary.ended_at = Some(Utc::now());
        }
    }

    /// Every run this session, newest first.
    pub fn runs(&self) -> Vec<RunSummary> {
        self.runs.iter().rev().map(|r| r.summary.clone()).collect()
    }
}

impl Drop for Orchestrator {
    /// Agents started by Mission Control do not outlive it.
    fn drop(&mut self) {
        for run in &mut self.runs {
            if let Some(child) = &mut run.child {
                let _ = child.kill();
            }
        }
    }
}

fn spawn_logged(mut cmd: Command, log_path: &Path) -> std::io::Result<Child> {
    let log = File::create(log_path)?;
    cmd.stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Without this every run flashes a console window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::{TaskKind, Tier};
    use std::time::{Duration, Instant};

    /// Stands in for a real CLI with `rustc`, which is always present where tests run.
    struct FakeAgent {
        args: &'static [&'static str],
    }

    impl Agent for FakeAgent {
        fn kind(&self) -> AgentKind {
            AgentKind::Claude
        }
        fn handles(&self, task: TaskKind) -> bool {
            task != TaskKind::Browse
        }
        fn model(&self, _tier: Tier) -> &'static str {
            "fake"
        }
        fn command(&self, _launch: &Launch) -> Command {
            let mut cmd = Command::new("rustc");
            cmd.args(self.args);
            cmd
        }
    }

    fn orchestrator(args: &'static [&'static str]) -> (Orchestrator, PathBuf) {
        let root = std::env::temp_dir().join(format!("mc-test-{}", uuid::Uuid::new_v4()));
        let config = RuntimeConfig { runs_dir: root.join("runs"), scratch_dir: root.join("scratch") };
        (Orchestrator::new(config, vec![Box::new(FakeAgent { args })]), root)
    }

    fn wait_for_exit(orch: &mut Orchestrator) -> RunSummary {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            orch.poll();
            let run = orch.runs().remove(0);
            if run.status != RunStatus::Running || Instant::now() > deadline {
                return run;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn a_run_is_tracked_until_it_exits() {
        let (mut orch, root) = orchestrator(&["--version"]);
        let run = orch.start("Add a logout button", None).unwrap();
        assert_eq!(run.status, RunStatus::Running);
        assert_eq!(run.workdir, root.join("scratch").display().to_string());

        let done = wait_for_exit(&mut orch);
        assert_eq!(done.status, RunStatus::Finished);
        assert!(fs::read_to_string(&done.log_path).unwrap().contains("rustc"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_failing_agent_marks_the_run_failed() {
        let (mut orch, root) = orchestrator(&["--no-such-flag"]);
        orch.start("Add a logout button", None).unwrap();
        assert_eq!(wait_for_exit(&mut orch).status, RunStatus::Failed);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn goals_no_agent_can_do_are_refused() {
        let (mut orch, _) = orchestrator(&["--version"]);
        assert!(matches!(orch.start("Open YouTube and play lofi", None), Err(StartError::NoAgent(_))));
        assert!(matches!(orch.start("  ", None), Err(StartError::EmptyGoal)));
        assert!(orch.runs().is_empty());
    }
}
