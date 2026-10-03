use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mission_control::{
    Answer, Board, BoardSnapshot, ClaudeAssistant, ClaudeCode, GitError, GitRepo, Orchestrator, PendingApproval, PullRequest, RepoStatus,
    RunSummary, RuntimeConfig, Settings, TranscriptWatcher, WatcherConfig,
};
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

const POLL_INTERVAL: Duration = Duration::from_millis(1500);

type SharedBoard = Arc<Mutex<Board>>;
type SharedOrchestrator = Arc<Mutex<Orchestrator>>;

#[tauri::command]
fn board_snapshot(board: tauri::State<SharedBoard>) -> BoardSnapshot {
    board.lock().unwrap().snapshot(chrono::Utc::now())
}

/// Routes the goal and starts an agent on it, in `folder` or Mission Control's scratch folder,
/// with any files the user dropped on it.
#[tauri::command]
fn start_task(
    orchestrator: tauri::State<SharedOrchestrator>,
    prompt: String,
    folder: Option<PathBuf>,
    attachments: Option<Vec<PathBuf>>,
) -> Result<RunSummary, String> {
    let attachments = attachments.unwrap_or_default();
    orchestrator.lock().unwrap().start(&prompt, folder.as_deref(), &attachments).map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_task(orchestrator: tauri::State<SharedOrchestrator>, id: String) -> bool {
    orchestrator.lock().unwrap().cancel(&id)
}

#[tauri::command]
fn get_settings(orchestrator: tauri::State<SharedOrchestrator>) -> Settings {
    orchestrator.lock().unwrap().settings().clone()
}

/// Saves new Command Centre settings and returns them as stored, after clean-up.
#[tauri::command]
fn update_settings(
    app: tauri::AppHandle,
    orchestrator: tauri::State<SharedOrchestrator>,
    settings: Settings,
) -> Result<Settings, String> {
    let saved = orchestrator.lock().unwrap().update_settings(settings).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-updated", saved.clone());
    Ok(saved)
}

/// Runs a git operation in the repository containing `folder`, off the UI thread, since pushes
/// and pulls wait on the network.
async fn in_repo<T: Send + 'static>(
    folder: PathBuf,
    op: impl FnOnce(&GitRepo) -> Result<T, GitError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || GitRepo::open(&folder).and_then(|repo| op(&repo)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_status(folder: PathBuf) -> Result<RepoStatus, String> {
    in_repo(folder, |repo| repo.status()).await
}

#[tauri::command]
async fn git_init(folder: PathBuf) -> Result<RepoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || GitRepo::init(&folder).and_then(|repo| repo.status()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_diff(folder: PathBuf, path: String, staged: bool) -> Result<String, String> {
    in_repo(folder, move |repo| repo.diff(&path, staged)).await
}

/// Stages `paths`, or everything when empty.
#[tauri::command]
async fn git_stage(folder: PathBuf, paths: Vec<String>) -> Result<(), String> {
    in_repo(folder, move |repo| repo.stage(&paths)).await
}

/// Unstages `paths`, or everything when empty. The work in the files is kept.
#[tauri::command]
async fn git_unstage(folder: PathBuf, paths: Vec<String>) -> Result<(), String> {
    in_repo(folder, move |repo| repo.unstage(&paths)).await
}

/// Commits what is staged and returns the new commit's short hash.
#[tauri::command]
async fn git_commit(folder: PathBuf, message: String) -> Result<String, String> {
    in_repo(folder, move |repo| repo.commit(&message)).await
}

#[tauri::command]
async fn git_push(folder: PathBuf) -> Result<(), String> {
    in_repo(folder, |repo| repo.push()).await
}

#[tauri::command]
async fn git_pull(folder: PathBuf) -> Result<(), String> {
    in_repo(folder, |repo| repo.pull()).await
}

#[tauri::command]
async fn git_fetch(folder: PathBuf) -> Result<(), String> {
    in_repo(folder, |repo| repo.fetch()).await
}

#[tauri::command]
async fn git_branches(folder: PathBuf) -> Result<Vec<String>, String> {
    in_repo(folder, |repo| repo.branches()).await
}

#[tauri::command]
async fn git_create_branch(folder: PathBuf, name: String) -> Result<(), String> {
    in_repo(folder, move |repo| repo.create_branch(&name)).await
}

#[tauri::command]
async fn git_switch_branch(folder: PathBuf, name: String) -> Result<(), String> {
    in_repo(folder, move |repo| repo.switch_branch(&name)).await
}

#[tauri::command]
async fn github_pull_request(folder: PathBuf) -> Result<Option<PullRequest>, String> {
    in_repo(folder, |repo| repo.pull_request()).await
}

/// Opens a pull request for the current branch and returns its URL.
#[tauri::command]
async fn github_create_pull_request(folder: PathBuf, title: String, body: String, draft: bool) -> Result<String, String> {
    in_repo(folder, move |repo| repo.create_pull_request(&title, &body, draft)).await
}

#[tauri::command]
fn runs_snapshot(orchestrator: tauri::State<SharedOrchestrator>) -> Vec<RunSummary> {
    orchestrator.lock().unwrap().runs()
}

#[tauri::command]
fn approvals_snapshot(orchestrator: tauri::State<SharedOrchestrator>) -> Vec<PendingApproval> {
    orchestrator.lock().unwrap().approvals()
}

/// Allows or denies a pending permission request. Returns false if it was no longer pending.
#[tauri::command]
fn answer_approval(
    orchestrator: tauri::State<SharedOrchestrator>,
    run_id: String,
    request_id: String,
    allow: bool,
) -> bool {
    let answer = if allow { Answer::Allow } else { Answer::Deny("The user denied this in Mission Control.".into()) };
    orchestrator.lock().unwrap().answer(&run_id, &request_id, answer)
}

/// Gap between the top edge of the screen and the pill window.
const PILL_TOP_MARGIN: f64 = 0.0;

/// Resizes the pill window and keeps it pinned to the top centre of its monitor.
#[tauri::command]
fn set_pill_size(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    place_pill(&window, width, height).map_err(|e| e.to_string())
}

fn place_pill(window: &WebviewWindow, width: f64, height: f64) -> tauri::Result<()> {
    window.set_size(LogicalSize::new(width, height))?;
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let x = monitor.position().x as f64 + (monitor.size().width as f64 - width * scale) / 2.0;
        let y = monitor.position().y as f64 + PILL_TOP_MARGIN * scale;
        window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))?;
    }
    Ok(())
}

#[tauri::command]
fn open_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("dashboard window is missing")?;
    window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus()).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Tails agent transcripts in the background and pushes a fresh board and run list to the UI on
/// every poll, so time-based statuses such as "stalled" update even when no new events arrive.
/// With "watch other sessions" off in the Command Centre, only Mission Control's own runs are read.
fn spawn_watcher(app: tauri::AppHandle, board: SharedBoard, orchestrator: SharedOrchestrator) {
    let Some(config) = WatcherConfig::from_home() else {
        eprintln!("mission-control: could not find the home directory; agent monitoring is off");
        return;
    };
    std::thread::spawn(move || {
        let mut watcher = TranscriptWatcher::new(config);
        loop {
            let (runs, approvals, watch_all) = {
                let mut orchestrator = orchestrator.lock().unwrap();
                orchestrator.poll();
                (orchestrator.runs(), orchestrator.approvals(), orchestrator.settings().watch_other_sessions)
            };
            let own: HashSet<String> = runs.iter().map(|r| r.id.clone()).collect();
            watcher.restrict_to(if watch_all { None } else { Some(own.clone()) });

            let events = watcher.poll();
            let snapshot = {
                let mut board = board.lock().unwrap();
                for event in events {
                    board.apply(event);
                }
                if !watch_all {
                    board.forget_sessions_except(|id| own.contains(id));
                }
                board.snapshot(chrono::Utc::now())
            };
            let _ = app.emit("board-updated", snapshot);
            let _ = app.emit("runs-updated", runs);
            let _ = app.emit("approvals-updated", approvals);
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SharedBoard::default())
        .setup(|app| {
            let runtime = RuntimeConfig::from_home().ok_or("could not find the home directory")?;
            let orchestrator: SharedOrchestrator = Arc::new(Mutex::new(Orchestrator::new(runtime, vec![Arc::new(ClaudeCode), Arc::new(ClaudeAssistant)])));
            app.manage(orchestrator.clone());
            let board = app.state::<SharedBoard>().inner().clone();
            spawn_watcher(app.handle().clone(), board, orchestrator);
            if let Some(pill) = app.get_webview_window("pill") {
                place_pill(&pill, 240.0, 72.0)?;
                pill.show()?;
            }
            Ok(())
        })
        // The pill is the app; closing the dashboard only hides it until the pill reopens it.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            board_snapshot,
            start_task,
            cancel_task,
            runs_snapshot,
            get_settings,
            update_settings,
            git_status,
            git_init,
            git_diff,
            git_stage,
            git_unstage,
            git_commit,
            git_push,
            git_pull,
            git_fetch,
            git_branches,
            git_create_branch,
            git_switch_branch,
            github_pull_request,
            github_create_pull_request,
            approvals_snapshot,
            answer_approval,
            set_pill_size,
            open_dashboard,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
