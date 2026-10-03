//! Turns a goal into a running agent: routes it, picks an agent that can do it, starts the
//! process, answers or forwards its permission requests and keeps track of it until it exits.
//! The Command Centre's settings bound every step.
//!
//! Progress inside a run is not read here. Each run uses a session ID chosen up front, so the
//! transcript watcher reports its events under that same ID on the board.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::agent::{Agent, Answer, ApprovalRequest, HostMessage, Launch};
use crate::events::AgentKind;
use crate::router::{self, Access, Decision, Tier};
use crate::git::{self, GitAction, GitRepo};
use crate::settings::{GitRule, Settings};

pub struct RuntimeConfig {
    /// One log file per run, holding everything the agent wrote.
    pub runs_dir: PathBuf,
    /// Where goals that are not about any folder run.
    pub scratch_dir: PathBuf,
    /// The Command Centre's settings.
    pub settings_path: PathBuf,
}

impl RuntimeConfig {
    pub fn from_home() -> Option<Self> {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
        let root = PathBuf::from(home).join(".mission-control");
        Some(Self {
            runs_dir: root.join("runs"),
            scratch_dir: root.join("scratch"),
            settings_path: root.join("settings.json"),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    /// Waiting for the agent's app connections before handing it the goal.
    Starting,
    Running,
    /// Paused until someone answers one of its permission requests.
    NeedsApproval,
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
    /// The agent's final answer, in full, once it has finished the goal.
    pub result: Option<String>,
    /// Requests the Command Centre's rules answered without asking.
    pub auto_allowed: u32,
    pub auto_denied: u32,
}

/// A permission request waiting for an answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub run_id: String,
    pub agent: AgentKind,
    /// The run's folder, so the prompt can say where the action would happen.
    pub workdir: String,
    #[serde(flatten)]
    pub request: ApprovalRequest,
    pub asked_at: DateTime<Utc>,
}

#[derive(Debug)]
pub enum StartError {
    EmptyGoal,
    MissingFolder(PathBuf),
    /// An attached file or folder does not exist.
    MissingAttachment(PathBuf),
    /// The Command Centre does not allow runs in this folder.
    FolderNotAllowed(PathBuf),
    /// No registered agent can do this kind of task yet.
    NoAgent(Decision),
    Spawn(std::io::Error),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyGoal => write!(f, "the goal is empty"),
            Self::MissingFolder(path) => write!(f, "{} is not a folder", path.display()),
            Self::MissingAttachment(path) => write!(f, "{} does not exist", path.display()),
            Self::FolderNotAllowed(path) => {
                write!(f, "the Command Centre does not allow runs in {}", path.display())
            }
            Self::NoAgent(d) => write!(f, "no enabled agent can handle {:?} tasks", d.task),
            Self::Spawn(err) => write!(f, "could not start the agent: {err}"),
        }
    }
}

impl std::error::Error for StartError {}

/// What a read-only run is told when it asks for anything beyond reading.
const READ_ONLY_REFUSAL: &str =
    "This run is read-only: Mission Control started it to answer a question, not to change anything.";
const LOCKDOWN_REASON: &str = " Read-only, because read-only mode is on in the Command Centre.";
/// How long a run waits for its app connections before starting without the slow ones.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

struct Run {
    summary: RunSummary,
    agent: Arc<dyn Agent>,
    child: Option<Child>,
    /// Open until the agent finishes its goal; closing it lets the agent exit.
    stdin: Option<ChildStdin>,
    /// The goal, held back until the agent's app connections are ready.
    waiting_goal: Option<String>,
    started: Instant,
    /// A readiness probe is out and has not been answered yet.
    probing: bool,
}

pub struct Orchestrator {
    config: RuntimeConfig,
    settings: Settings,
    agents: Vec<Arc<dyn Agent>>,
    runs: Vec<Run>,
    pending: Vec<PendingApproval>,
    /// Reader threads, one per run, forward what the agents say here.
    inbox: Receiver<(String, HostMessage)>,
    outbox: Sender<(String, HostMessage)>,
}

impl Orchestrator {
    /// `agents` are tried in order; the first that handles a task gets it.
    pub fn new(config: RuntimeConfig, agents: Vec<Arc<dyn Agent>>) -> Self {
        let (outbox, inbox) = mpsc::channel();
        let settings = Settings::load(&config.settings_path);
        Self { config, settings, agents, runs: Vec::new(), pending: Vec::new(), inbox, outbox }
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// Applies new Command Centre settings to future runs and requests, and saves them.
    pub fn update_settings(&mut self, settings: Settings) -> std::io::Result<Settings> {
        let settings = settings.normalized();
        settings.save(&self.config.settings_path)?;
        self.settings = settings.clone();
        Ok(settings)
    }

    /// Whether this session ID belongs to a run Mission Control started.
    pub fn owns_session(&self, session_id: &str) -> bool {
        self.runs.iter().any(|r| r.summary.id == session_id)
    }

    /// Routes `goal`, starts an agent on it in `folder` (or the scratch folder) with any
    /// `attachments` the user handed over, and returns the run.
    pub fn start(&mut self, goal: &str, folder: Option<&Path>, attachments: &[PathBuf]) -> Result<RunSummary, StartError> {
        let goal = goal.trim();
        if goal.is_empty() {
            return Err(StartError::EmptyGoal);
        }
        if let Some(missing) = attachments.iter().find(|a| !a.exists()) {
            return Err(StartError::MissingAttachment(missing.clone()));
        }
        let workdir = match folder {
            Some(dir) if !dir.is_dir() => return Err(StartError::MissingFolder(dir.to_path_buf())),
            Some(dir) if !self.settings.allows_folder(dir) => {
                return Err(StartError::FolderNotAllowed(dir.to_path_buf()));
            }
            Some(dir) => dir.to_path_buf(),
            None => {
                fs::create_dir_all(&self.config.scratch_dir).map_err(StartError::Spawn)?;
                self.config.scratch_dir.clone()
            }
        };

        let context = router::Context { folder: folder.is_some(), attachments: !attachments.is_empty() };
        let decision = bounded(router::route(goal, context), &self.settings);
        if !self.settings.allows_task(decision.task) {
            return Err(StartError::NoAgent(decision));
        }
        let Some(agent) = self.agents.iter().find(|a| a.handles(decision.task)).cloned() else {
            return Err(StartError::NoAgent(decision));
        };

        let id = uuid::Uuid::new_v4().to_string();
        let launch = Launch {
            session_id: &id,
            goal,
            workdir: &workdir,
            attachments,
            tier: decision.tier,
            access: decision.access,
            ask_before_edits: self.settings.ask_before_edits,
            max_budget_usd: self.settings.max_budget_usd,
            notion_parent: self.settings.notion_parent.as_deref(),
        };
        fs::create_dir_all(&self.config.runs_dir).map_err(StartError::Spawn)?;
        let log_path = self.config.runs_dir.join(format!("{id}.log"));
        let log = File::create(&log_path).map_err(StartError::Spawn)?;

        let mut child = spawn_hosted(agent.command(&launch), &log).map_err(StartError::Spawn)?;
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        // Agents that work in apps first say when their connections are ready; the goal waits.
        let goal_line = agent.goal_message(goal, attachments);
        let (first_line, waiting_goal, status) = match agent.readiness_probe() {
            Some(probe) => (probe, Some(goal_line), RunStatus::Starting),
            None => (goal_line, None, RunStatus::Running),
        };
        if let Err(err) = writeln!(stdin, "{first_line}") {
            let _ = child.kill();
            return Err(StartError::Spawn(err));
        }
        spawn_reader(id.clone(), agent.clone(), stdout, log, self.outbox.clone());

        let summary = RunSummary {
            id: id.clone(),
            goal: goal.to_string(),
            workdir: workdir.display().to_string(),
            agent: agent.kind(),
            model: agent.model(decision.tier).to_string(),
            decision,
            status,
            exit_code: None,
            started_at: Utc::now(),
            ended_at: None,
            log_path: log_path.display().to_string(),
            result: None,
            auto_allowed: 0,
            auto_denied: 0,
        };
        let probing = waiting_goal.is_some();
        self.runs.push(Run {
            summary: summary.clone(),
            agent,
            child: Some(child),
            stdin: Some(stdin),
            waiting_goal,
            started: Instant::now(),
            probing,
        });
        Ok(summary)
    }

    /// Answers a pending permission request. Returns false if it is no longer pending.
    pub fn answer(&mut self, run_id: &str, request_id: &str, answer: Answer) -> bool {
        let Some(index) = self.pending.iter().position(|p| p.run_id == run_id && p.request.request_id == request_id)
        else {
            return false;
        };
        let pending = self.pending.remove(index);
        let Some(run) = self.runs.iter_mut().find(|r| r.summary.id == run_id) else {
            return false;
        };
        send(run, &pending.request, &answer);
        if !self.pending.iter().any(|p| p.run_id == run_id) && run.summary.status == RunStatus::NeedsApproval {
            run.summary.status = RunStatus::Running;
        }
        true
    }

    /// Stops a run. Returns false if there is no such run or it already ended.
    pub fn cancel(&mut self, id: &str) -> bool {
        let Some(run) = self.runs.iter_mut().find(|r| r.summary.id == id) else {
            return false;
        };
        let Some(mut child) = run.child.take() else {
            return false;
        };
        run.stdin = None;
        let _ = child.kill();
        let _ = child.wait();
        run.summary.status = RunStatus::Cancelled;
        run.summary.ended_at = Some(Utc::now());
        self.pending.retain(|p| p.run_id != id);
        true
    }

    /// Handles what agents have said and notices runs that have exited. Call it regularly;
    /// it never blocks.
    pub fn poll(&mut self) {
        while let Ok((run_id, message)) = self.inbox.try_recv() {
            let Some(run) = self.runs.iter_mut().find(|r| r.summary.id == run_id) else { continue };
            match message {
                HostMessage::Finished(result) => {
                    run.summary.result = result;
                    run.stdin = None;
                }
                HostMessage::Ready(true) => release_goal(run),
                HostMessage::Ready(false) => run.probing = false,
                HostMessage::Approval(request) => {
                    let workdir = Path::new(&run.summary.workdir);
                    if let Some(answer) = auto_answer(&self.settings, run.summary.decision.access, &request, workdir) {
                        match answer {
                            Answer::Allow => run.summary.auto_allowed += 1,
                            Answer::Deny(_) => run.summary.auto_denied += 1,
                        }
                        send(run, &request, &answer);
                        continue;
                    }
                    run.summary.status = RunStatus::NeedsApproval;
                    self.pending.push(PendingApproval {
                        run_id,
                        agent: run.summary.agent,
                        workdir: run.summary.workdir.clone(),
                        request,
                        asked_at: Utc::now(),
                    });
                }
            }
        }

        // Keep asking runs that are still connecting, and stop waiting on slow connections.
        for run in self.runs.iter_mut().filter(|r| r.waiting_goal.is_some() && r.child.is_some()) {
            if run.started.elapsed() > CONNECT_TIMEOUT {
                release_goal(run);
            } else if !run.probing {
                if let Some(probe) = run.agent.readiness_probe() {
                    write_line(run, &probe);
                }
                run.probing = true;
            }
        }

        for run in &mut self.runs {
            let Some(child) = &mut run.child else { continue };
            let status = match child.try_wait() {
                Ok(Some(status)) => status,
                Ok(None) => continue,
                Err(err) => {
                    eprintln!("mission-control: lost track of run {}: {err}", run.summary.id);
                    run.child = None;
                    run.stdin = None;
                    run.summary.status = RunStatus::Failed;
                    run.summary.ended_at = Some(Utc::now());
                    continue;
                }
            };
            run.child = None;
            run.stdin = None;
            run.summary.exit_code = status.code();
            run.summary.status = if status.success() { RunStatus::Finished } else { RunStatus::Failed };
            run.summary.ended_at = Some(Utc::now());
        }
        let live: Vec<&str> = self.runs.iter().filter(|r| r.child.is_some()).map(|r| r.summary.id.as_str()).collect();
        self.pending.retain(|p| live.contains(&p.run_id.as_str()));
    }

    /// Every run this session, newest first.
    pub fn runs(&self) -> Vec<RunSummary> {
        self.runs.iter().rev().map(|r| r.summary.clone()).collect()
    }

    /// Permission requests waiting for an answer, oldest first.
    pub fn approvals(&self) -> Vec<PendingApproval> {
        self.pending.clone()
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

/// Applies the Command Centre's limits to the router's decision.
fn bounded(mut decision: Decision, settings: &Settings) -> Decision {
    if decision.tier > settings.max_tier {
        decision.tier = settings.max_tier;
        let name = match settings.max_tier {
            Tier::Fast => "fast",
            Tier::Balanced => "balanced",
            Tier::Strongest => "strongest",
        };
        decision.reason.push_str(&format!(" Capped at the {name} model in the Command Centre."));
    }
    if settings.read_only_mode && decision.access != Access::ReadOnly {
        decision.access = Access::ReadOnly;
        decision.reason.push_str(LOCKDOWN_REASON);
    }
    decision
}

/// The answer the Command Centre's rules give a request without asking, if any.
///
/// A run's read-only access is Mission Control's promise to the user, so it is enforced here
/// rather than trusted to the agent's own permission mode, and it outranks everything else.
/// Git rules come next: "never" and protected branches outrank full autonomy.
fn auto_answer(settings: &Settings, access: Access, request: &ApprovalRequest, workdir: &Path) -> Option<Answer> {
    if access == Access::ReadOnly {
        return Some(Answer::Deny(READ_ONLY_REFUSAL.into()));
    }
    if let Some(action) = request.input["command"].as_str().and_then(git::classify) {
        let (rule, what) = match action {
            GitAction::Commit => (settings.agent_commit, "Committing"),
            GitAction::Publish => (settings.agent_push, "Pushing and publishing to GitHub"),
        };
        if rule == GitRule::Never {
            return Some(Answer::Deny(format!(
                "{what} is turned off for agents in Mission Control's Command Centre. Leave it to the user."
            )));
        }
        let branch = GitRepo::open(workdir).ok().and_then(|repo| repo.current_branch());
        if branch.is_some_and(|b| settings.protected_branches.contains(&b)) {
            return None;
        }
        if rule == GitRule::Allow {
            return Some(Answer::Allow);
        }
    }
    if settings.full_autonomy || settings.auto_approves(&request.detail) {
        Some(Answer::Allow)
    } else {
        None
    }
}

fn send(run: &mut Run, request: &ApprovalRequest, answer: &Answer) {
    let line = run.agent.reply(request, answer);
    write_line(run, &line);
}

/// Hands a waiting run its goal.
fn release_goal(run: &mut Run) {
    let Some(goal) = run.waiting_goal.take() else { return };
    write_line(run, &goal);
    if run.summary.status == RunStatus::Starting {
        run.summary.status = RunStatus::Running;
    }
}

fn write_line(run: &mut Run, line: &str) {
    let Some(stdin) = &mut run.stdin else { return };
    if let Err(err) = writeln!(stdin, "{line}").and_then(|_| stdin.flush()) {
        eprintln!("mission-control: could not write to run {}: {err}", run.summary.id);
    }
}

/// Starts the agent with Mission Control on its stdin and stdout, and stderr going to the log.
fn spawn_hosted(mut cmd: Command, log: &File) -> std::io::Result<Child> {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log.try_clone()?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Without this every run flashes a console window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// Copies the agent's stdout to the log and forwards anything the orchestrator must act on.
fn spawn_reader(
    run_id: String,
    agent: Arc<dyn Agent>,
    stdout: ChildStdout,
    mut log: File,
    outbox: Sender<(String, HostMessage)>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = writeln!(log, "{line}");
            if let Some(message) = agent.parse(&line) {
                if outbox.send((run_id.clone(), message)).is_err() {
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::{TaskKind, Tier};
    use std::time::{Duration, Instant};

    /// Stands in for a real CLI with `rustc`, which is always present where tests run.
    struct FakeAgent {
        args: Vec<String>,
        /// Acts like an agent that must connect to apps before taking its goal.
        connects_first: bool,
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
        fn command(&self, launch: &Launch) -> Command {
            let mut cmd = Command::new("rustc");
            cmd.current_dir(launch.workdir).args(&self.args);
            cmd
        }
        fn readiness_probe(&self) -> Option<String> {
            self.connects_first.then(|| "// are you ready?".into())
        }
        fn goal_message(&self, _goal: &str, _attachments: &[PathBuf]) -> String {
            "fn main() {}".into()
        }
        fn parse(&self, _line: &str) -> Option<HostMessage> {
            None
        }
        /// A comment, so the fake's "program" still compiles after being answered.
        fn reply(&self, request: &ApprovalRequest, answer: &Answer) -> String {
            format!("// {} {answer:?}", request.request_id)
        }
    }

    /// Reads a program from stdin, so it stays alive until its stdin closes.
    const WAITS_FOR_STDIN: &[&str] = &["-", "--emit=metadata", "--crate-name", "mc_fake"];

    fn orchestrator(args: &[&str]) -> (Orchestrator, PathBuf) {
        orchestrator_with(args, false)
    }

    fn orchestrator_with(args: &[&str], connects_first: bool) -> (Orchestrator, PathBuf) {
        let root = std::env::temp_dir().join(format!("mc-test-{}", uuid::Uuid::new_v4()));
        let config = RuntimeConfig {
            runs_dir: root.join("runs"),
            scratch_dir: root.join("scratch"),
            settings_path: root.join("settings.json"),
        };
        let agent = FakeAgent { args: args.iter().map(|a| a.to_string()).collect(), connects_first };
        (Orchestrator::new(config, vec![Arc::new(agent)]), root)
    }

    fn wait_for_exit(orch: &mut Orchestrator) -> RunSummary {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            orch.poll();
            let run = orch.runs().remove(0);
            let ended = !matches!(run.status, RunStatus::Running | RunStatus::NeedsApproval);
            if ended || Instant::now() > deadline {
                return run;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn ask(orch: &Orchestrator, run_id: &str, request_id: &str) {
        let request = ApprovalRequest {
            request_id: request_id.into(),
            tool: "Bash".into(),
            label: "Bash".into(),
            detail: "npm install".into(),
            description: None,
            input: serde_json::Value::Null,
        };
        orch.outbox.send((run_id.into(), HostMessage::Approval(request))).unwrap();
    }

    #[test]
    fn a_run_is_tracked_until_it_exits() {
        let (mut orch, root) = orchestrator(&["--version"]);
        let run = orch.start("Add a logout button", None, &[]).unwrap();
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
        orch.start("Add a logout button", None, &[]).unwrap();
        assert_eq!(wait_for_exit(&mut orch).status, RunStatus::Failed);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn requests_wait_for_an_answer_and_finishing_lets_the_agent_exit() {
        let (mut orch, root) = orchestrator(WAITS_FOR_STDIN);
        let run = orch.start("Add a logout button", None, &[]).unwrap();

        ask(&orch, &run.id, "r1");
        orch.poll();
        assert_eq!(orch.runs()[0].status, RunStatus::NeedsApproval);
        assert_eq!(orch.approvals().len(), 1);

        assert!(orch.answer(&run.id, "r1", Answer::Allow));
        assert!(!orch.answer(&run.id, "r1", Answer::Allow), "an answered request is no longer pending");
        assert_eq!(orch.runs()[0].status, RunStatus::Running);
        assert!(orch.approvals().is_empty());

        // Still waiting on stdin, so still running, until the agent reports it is done.
        orch.poll();
        assert_eq!(orch.runs()[0].status, RunStatus::Running);
        orch.outbox.send((run.id.clone(), HostMessage::Finished(Some("done".into())))).unwrap();
        let done = wait_for_exit(&mut orch);
        assert_eq!((done.status, done.result.as_deref()), (RunStatus::Finished, Some("done")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_only_runs_are_refused_without_asking() {
        let (mut orch, root) = orchestrator(WAITS_FOR_STDIN);
        let run = orch.start("What is in this folder?", None, &[]).unwrap();
        assert_eq!(run.decision.access, Access::ReadOnly);
        ask(&orch, &run.id, "r1");
        orch.poll();
        assert!(orch.approvals().is_empty());
        assert_eq!(orch.runs()[0].status, RunStatus::Running);
        assert!(orch.cancel(&run.id));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn goals_no_agent_can_do_are_refused() {
        let (mut orch, _) = orchestrator(&["--version"]);
        assert!(matches!(orch.start("Open YouTube and play lofi", None, &[]), Err(StartError::NoAgent(_))));
        assert!(matches!(orch.start("  ", None, &[]), Err(StartError::EmptyGoal)));
        assert!(orch.runs().is_empty());
    }

    fn set(orch: &mut Orchestrator, change: impl FnOnce(&mut Settings)) {
        let mut settings = orch.settings().clone();
        change(&mut settings);
        orch.update_settings(settings).unwrap();
    }

    #[test]
    fn command_centre_rules_answer_requests_without_asking() {
        let (mut orch, root) = orchestrator(WAITS_FOR_STDIN);
        let run = orch.start("Add a logout button", None, &[]).unwrap();

        set(&mut orch, |s| s.auto_approve = vec!["npm install".into()]);
        ask(&orch, &run.id, "listed");
        orch.poll();
        assert!(orch.approvals().is_empty());

        set(&mut orch, |s| s.auto_approve.clear());
        ask(&orch, &run.id, "unlisted");
        orch.poll();
        assert_eq!(orch.approvals().len(), 1);

        set(&mut orch, |s| s.full_autonomy = true);
        ask(&orch, &run.id, "autonomous");
        orch.poll();
        assert_eq!(orch.approvals().len(), 1, "only the request asked before autonomy was on is waiting");
        assert_eq!(orch.runs()[0].auto_allowed, 2);

        orch.cancel(&run.id);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_only_beats_full_autonomy() {
        let (mut orch, root) = orchestrator(WAITS_FOR_STDIN);
        set(&mut orch, |s| {
            s.full_autonomy = true;
            s.read_only_mode = true;
        });
        let run = orch.start("Add a logout button", None, &[]).unwrap();
        assert_eq!(run.decision.access, Access::ReadOnly);
        assert!(run.decision.reason.contains("read-only mode"));

        ask(&orch, &run.id, "r1");
        orch.poll();
        assert_eq!((orch.runs()[0].auto_allowed, orch.runs()[0].auto_denied), (0, 1));
        orch.cancel(&run.id);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn command_centre_limits_where_and_how_runs_start() {
        let (mut orch, root) = orchestrator(&["--version"]);

        set(&mut orch, |s| s.max_tier = Tier::Fast);
        let run = orch.start("Refactor the auth module", None, &[]).unwrap();
        assert_eq!(run.decision.tier, Tier::Fast);
        assert!(run.decision.reason.contains("Capped"));

        set(&mut orch, |s| s.allowed_folders = vec![root.join("scratch")]);
        let elsewhere = std::env::temp_dir();
        assert!(matches!(orch.start("Add a button", Some(&elsewhere), &[]), Err(StartError::FolderNotAllowed(_))));
        assert!(orch.start("Add a button", None, &[]).is_ok(), "the scratch folder is always allowed");

        set(&mut orch, |s| s.claude_enabled = false);
        assert!(matches!(orch.start("Add a button", None, &[]), Err(StartError::NoAgent(_))));

        let saved = Settings::load(&root.join("settings.json"));
        assert!(!saved.claude_enabled && saved.max_tier == Tier::Fast);
        let _ = fs::remove_dir_all(root);
    }

    fn ask_command(orch: &Orchestrator, run_id: &str, request_id: &str, command: &str) {
        let request = ApprovalRequest {
            request_id: request_id.into(),
            tool: "Bash".into(),
            label: "Bash".into(),
            detail: command.into(),
            description: None,
            input: serde_json::json!({ "command": command }),
        };
        orch.outbox.send((run_id.into(), HostMessage::Approval(request))).unwrap();
    }

    #[test]
    fn git_rules_outrank_autonomy_and_protect_branches() {
        let (mut orch, root) = orchestrator(WAITS_FOR_STDIN);
        let repo = root.join("repo");
        GitRepo::init(&repo).unwrap();
        let switch = |branch: &str| {
            Command::new("git").current_dir(&repo).args(["checkout", "-q", "-b", branch]).output().unwrap();
        };
        switch("main");
        let run = orch.start("Add a logout button", Some(&repo), &[]).unwrap();
        let pending = |orch: &Orchestrator| orch.approvals().into_iter().map(|a| a.request.request_id).collect::<Vec<_>>();

        set(&mut orch, |s| {
            s.full_autonomy = true;
            s.agent_push = GitRule::Never;
        });
        ask_command(&orch, &run.id, "push", "git add . && git push");
        ask_command(&orch, &run.id, "commit on main", "git commit -m wip");
        ask_command(&orch, &run.id, "tests", "npm test");
        orch.poll();
        assert_eq!(orch.runs()[0].auto_denied, 1, "never beats full autonomy");
        assert_eq!(pending(&orch), ["commit on main"], "a protected branch always asks");
        assert_eq!(orch.runs()[0].auto_allowed, 1, "other commands follow full autonomy");

        switch("feature");
        set(&mut orch, |s| {
            s.full_autonomy = false;
            s.agent_commit = GitRule::Allow;
        });
        ask_command(&orch, &run.id, "commit on feature", "git commit -m wip");
        ask_command(&orch, &run.id, "push on feature", "git push");
        orch.poll();
        assert_eq!(orch.runs()[0].auto_allowed, 2);
        assert_eq!(orch.runs()[0].auto_denied, 2);
        assert_eq!(pending(&orch), ["commit on main"]);

        orch.cancel(&run.id);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_run_that_connects_to_apps_gets_its_goal_once_they_are_ready() {
        let (mut orch, root) = orchestrator_with(WAITS_FOR_STDIN, true);
        let run = orch.start("Add a logout button", None, &[]).unwrap();
        assert_eq!(run.status, RunStatus::Starting);

        orch.outbox.send((run.id.clone(), HostMessage::Ready(false))).unwrap();
        orch.poll();
        assert_eq!(orch.runs()[0].status, RunStatus::Starting, "still connecting");

        orch.outbox.send((run.id.clone(), HostMessage::Ready(true))).unwrap();
        orch.poll();
        assert_eq!(orch.runs()[0].status, RunStatus::Running);

        // The fake compiles what it was sent, so it only succeeds if the goal arrived.
        orch.outbox.send((run.id.clone(), HostMessage::Finished(Some("done".into())))).unwrap();
        let done = wait_for_exit(&mut orch);
        assert_eq!((done.status, done.result.as_deref()), (RunStatus::Finished, Some("done")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn attachments_must_exist_and_the_assistant_can_be_switched_off() {
        let (mut orch, root) = orchestrator(&["--version"]);
        let missing = root.join("nope.pdf");
        assert!(matches!(orch.start("Summarise this", None, &[missing]), Err(StartError::MissingAttachment(_))));

        set(&mut orch, |s| s.assistant_enabled = false);
        assert!(matches!(orch.start("Create a Notion page", None, &[]), Err(StartError::NoAgent(_))));
        let _ = fs::remove_dir_all(root);
    }
}
