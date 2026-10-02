import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BlobAvatar } from "./avatar/BlobAvatar";
import { leadState, pillCrew, progressSteps, roleOf, sessionState, STATE_LABEL } from "./avatar/pillState";
import type { BoardSnapshot, SessionSummary } from "./types";
import "./Pill.css";

const COLLAPSED = { width: 240, height: 72 };
const EXPANDED = { width: 420, height: 380 };
// Room for the panel plus a column per agent on the right.
const DETAILED = { width: 900, height: 380 };
// Matches the --morph transition in Pill.css, so the window shrinks only after the pill has.
const MORPH_MS = 320;

export default function Pill() {
  const [board, setBoard] = useState<BoardSnapshot>({ sessions: [], feed: [] });
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(false);
  const [prompt, setPrompt] = useState("");
  const collapseTimer = useRef<number>(undefined);

  useEffect(() => {
    invoke<BoardSnapshot>("board_snapshot").then(setBoard);
    const unlisten = listen<BoardSnapshot>("board-updated", (e) => setBoard(e.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  async function expand() {
    window.clearTimeout(collapseTimer.current);
    await invoke("set_pill_size", EXPANDED);
    setExpanded(true);
  }

  function collapse() {
    setExpanded(false);
    setDetails(false);
    collapseTimer.current = window.setTimeout(() => invoke("set_pill_size", COLLAPSED), MORPH_MS);
  }

  // Clicking anywhere else on the desktop tucks the pill away again.
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) collapse();
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  const active = board.sessions.filter((s) => s.status !== "idle");
  const lead = leadState(active);
  const crew = pillCrew(active);

  async function toggleDetails() {
    if (details) {
      setDetails(false);
      collapseTimer.current = window.setTimeout(() => invoke("set_pill_size", EXPANDED), MORPH_MS);
    } else {
      window.clearTimeout(collapseTimer.current);
      await invoke("set_pill_size", DETAILED);
      setDetails(true);
    }
  }

  async function submit() {
    if (!prompt.trim()) return;
    await invoke<string>("start_task", { prompt });
    setPrompt("");
  }

  return (
    <div className="stage">
      <div
        className={`pill ${lead} ${expanded ? "expanded" : ""} ${details ? "detailed" : ""}`}
        onClick={expanded ? undefined : expand}
        onKeyDown={(e) => e.key === "Escape" && collapse()}
        role={expanded ? undefined : "button"}
        aria-label={expanded ? undefined : `Mission Control: ${STATE_LABEL[lead]}`}
      >
        <div className="pill-face">
          <BlobAvatar role="mc" state={lead} size={30} />
          {crew.length > 0 && (
            <span className="crew">
              {crew.map((s) => (
                <BlobAvatar key={`${s.agent}:${s.sessionId}`} role={roleOf(s.agent)} state={sessionState(s)} size={18} />
              ))}
            </span>
          )}
        </div>

        {expanded && (
          <div className="panel">
            <div className="panel-main">
              <header className="panel-head">
                <span className="panel-avatar">
                  <BlobAvatar role="mc" state={lead} size={40} />
                </span>
                <div className="panel-title">
                  <strong>Mission Control</strong>
                  <span>{STATE_LABEL[lead]}</span>
                </div>
                <button className="ghost" onClick={() => invoke("open_dashboard")} title="Open dashboard">
                  ⧉
                </button>
                <button className="ghost" onClick={collapse} title="Collapse">
                  ⌃
                </button>
              </header>

              <ul className="agents">
                {active.length === 0 && <li className="empty">No agents running right now.</li>}
                {active.map((s) => (
                  <li key={`${s.agent}:${s.sessionId}`} className={sessionState(s)}>
                    <BlobAvatar role={roleOf(s.agent)} state={sessionState(s)} size={28} />
                    <div>
                      <div className="agent-name">
                        {s.agent === "claude" ? "Claude" : "Gemini"}
                        <span className="project">{projectName(s.project)}</span>
                      </div>
                      <div className="agent-activity">
                        {STATE_LABEL[sessionState(s)]} · {activityText(s)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              <form
                className="ask"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <span>›</span>
                <input
                  autoFocus
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="What do you want to do?"
                />
              </form>

              <footer className="panel-foot">
                <button className="link" onClick={toggleDetails} aria-expanded={details}>
                  {details ? "Hide details" : "Show details"}
                </button>
                <button className="link" onClick={() => invoke("quit_app")}>
                  Quit
                </button>
              </footer>
            </div>

            {details && (
              <section className="details" aria-label="Agent progress">
                {active.length === 0 && <p className="empty">Agents will show up here as they start work.</p>}
                {active.map((s) => (
                  <AgentColumn key={`${s.agent}:${s.sessionId}`} session={s} />
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentColumn({ session: s }: { session: SessionSummary }) {
  const state = sessionState(s);
  return (
    <article className={`agent-col ${state}`}>
      <header>
        <BlobAvatar role={roleOf(s.agent)} state={state} size={32} />
        <div>
          <div className="agent-name">{s.agent === "claude" ? "Claude" : "Gemini"}</div>
          <div className="project">{projectName(s.project)}</div>
        </div>
      </header>

      <ol className="steps">
        {progressSteps(state).map((step) => (
          <li key={step.label} className={step.status} aria-current={step.status === "current" ? "step" : undefined}>
            <span className="dot" />
            {step.label}
          </li>
        ))}
      </ol>

      <p className="agent-activity" title={activityText(s)}>
        {activityText(s)}
      </p>

      <footer className="agent-meta">
        <span>{s.toolCalls} tools</span>
        {s.toolErrors > 0 && <span className="errors">{s.toolErrors} failed</span>}
      </footer>
    </article>
  );
}

/** What the agent is on right now. "Thinking" is already the row's state, so show the prompt instead. */
function activityText(s: SessionSummary) {
  const activity = s.currentActivity === "Thinking" ? null : s.currentActivity;
  return activity ?? s.title ?? s.lastPrompt ?? "Waiting";
}

function projectName(path: string | null) {
  return path?.split(/[\\/]/).filter(Boolean).pop() ?? "";
}
