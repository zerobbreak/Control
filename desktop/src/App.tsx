import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist-mono/400.css";
import { mostUrgent } from "./avatar/pillState";
import { useBackend, useNow } from "./backend";
import ChangesPanel from "./ChangesPanel";
import CommandCentre from "./CommandCentre";
import { Sidebar } from "./desk/Sidebar";
import { RunView } from "./desk/RunView";
import { Today } from "./desk/Today";
import { parseView, workedFolders, type DeskView } from "./desk/desk";
import { isActive, runState } from "./runs";
import type { BoardSnapshot, PendingApproval, RunSummary, Settings } from "./types";
import "./theme.css";
import "./App.css";

const EMPTY_BOARD: BoardSnapshot = { sessions: [], feed: [] };

/** The Desk: Mission Control's main window. */
function App() {
  const board = useBackend<BoardSnapshot>("board_snapshot", "board-updated", EMPTY_BOARD);
  const runs = useBackend<RunSummary[]>("runs_snapshot", "runs-updated", []);
  const approvals = useBackend<PendingApproval[]>("approvals_snapshot", "approvals-updated", []);
  const settings = useBackend<Settings | null>("get_settings", "settings-updated", null);
  const [view, setView] = useState<DeskView>({ kind: "today" });
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState<{ key: number; paths: string[] } | null>(null);
  const now = useNow(runs.some(isActive));

  // The island opens the Desk on a view: "today", "changes", "boundaries" or "run:<id>".
  useEffect(() => {
    const unlisten = listen<string>("dashboard-view", (e) => setView(parseView(e.payload)));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  // Files and folders dropped anywhere on the Desk are handed to the goal box on Today.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter") {
        setDragging(true);
        setView({ kind: "today" });
      } else if (payload.type === "drop") {
        setDragging(false);
        setDropped({ key: Date.now(), paths: payload.paths });
      } else if (payload.type === "leave") {
        setDragging(false);
      }
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  const folders = useMemo(() => workedFolders(runs, board.sessions), [runs, board.sessions]);
  const lead = mostUrgent([...runs.filter(isActive).map(runState), ...(approvals.length > 0 ? (["needs"] as const) : [])]);
  // "Runs" with no run chosen opens the newest.
  const openRunId = view.kind === "run" ? (view.runId ?? runs[0]?.id ?? null) : null;

  return (
    <div className="desk">
      <Sidebar
        view={view}
        onNavigate={setView}
        runs={runs}
        settings={settings}
        waiting={approvals.length}
        lead={lead}
        openRunId={openRunId}
      />
      <main className={`desk-main${view.kind === "changes" || view.kind === "boundaries" ? " flush" : ""}`}>
        {view.kind === "today" && (
          <Today
            runs={runs}
            approvals={approvals}
            board={board}
            settings={settings}
            now={now}
            onNavigate={setView}
            dropped={dropped}
            dragging={dragging}
            onDropTaken={() => setDropped(null)}
          />
        )}
        {view.kind === "run" && (
          <RunView
            key={openRunId ?? "none"}
            run={runs.find((r) => r.id === openRunId)}
            board={board}
            approvals={approvals}
            settings={settings}
            now={now}
            onNavigate={setView}
          />
        )}
        {view.kind === "changes" && <ChangesPanel folders={folders} />}
        {view.kind === "boundaries" && <CommandCentre onViewAllSessions={() => setView({ kind: "today" })} />}
      </main>
    </div>
  );
}

export default App;
