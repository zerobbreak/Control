use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mission_control::{Board, BoardSnapshot, ClaudeCode, Orchestrator, RunSummary, RuntimeConfig, TranscriptWatcher, WatcherConfig};
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

const POLL_INTERVAL: Duration = Duration::from_millis(1500);

type SharedBoard = Arc<Mutex<Board>>;
type SharedOrchestrator = Arc<Mutex<Orchestrator>>;

#[tauri::command]
fn board_snapshot(board: tauri::State<SharedBoard>) -> BoardSnapshot {
    board.lock().unwrap().snapshot(chrono::Utc::now())
}

/// Routes the goal and starts an agent on it, in `folder` or Mission Control's scratch folder.
#[tauri::command]
fn start_task(
    orchestrator: tauri::State<SharedOrchestrator>,
    prompt: String,
    folder: Option<PathBuf>,
) -> Result<RunSummary, String> {
    orchestrator.lock().unwrap().start(&prompt, folder.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_task(orchestrator: tauri::State<SharedOrchestrator>, id: String) -> bool {
    orchestrator.lock().unwrap().cancel(&id)
}

#[tauri::command]
fn runs_snapshot(orchestrator: tauri::State<SharedOrchestrator>) -> Vec<RunSummary> {
    orchestrator.lock().unwrap().runs()
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
fn spawn_watcher(app: tauri::AppHandle, board: SharedBoard, orchestrator: SharedOrchestrator) {
    let Some(config) = WatcherConfig::from_home() else {
        eprintln!("mission-control: could not find the home directory; agent monitoring is off");
        return;
    };
    std::thread::spawn(move || {
        let mut watcher = TranscriptWatcher::new(config);
        loop {
            let events = watcher.poll();
            let snapshot = {
                let mut board = board.lock().unwrap();
                for event in events {
                    board.apply(event);
                }
                board.snapshot(chrono::Utc::now())
            };
            let runs = {
                let mut orchestrator = orchestrator.lock().unwrap();
                orchestrator.poll();
                orchestrator.runs()
            };
            let _ = app.emit("board-updated", snapshot);
            let _ = app.emit("runs-updated", runs);
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
            let orchestrator: SharedOrchestrator = Arc::new(Mutex::new(Orchestrator::new(runtime, vec![Box::new(ClaudeCode)])));
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
            set_pill_size,
            open_dashboard,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
