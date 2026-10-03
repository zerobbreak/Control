import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BlobAvatar } from "./avatar/BlobAvatar";
import { mostUrgent, progressSteps, roleOf, sessionState, STATE_LABEL } from "./avatar/pillState";
import { agentCards, elapsed, fileName, firstLink, linkLabel, statusCounts, type AgentCard } from "./runs";
import type { BoardSnapshot, PendingApproval, RunSummary, SessionSummary } from "./types";
import "./Pill.css";

const COLLAPSED = { width: 240, height: 72 };
const EXPANDED = { width: 460, height: 600 };
// Room for the panel plus a column per agent on the right.
const DETAILED = { width: 940, height: 600 };
// Matches the --morph transition in Pill.css, so the window shrinks only after the pill has.
const MORPH_MS = 320;

/** Subscribes to a backend event, seeded from a snapshot command so it is filled straight away. */
function useBackend<T>(command: string, event: string, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    invoke<T>(command).then(setValue);
    const unlisten = listen<T>(event, (e) => setValue(e.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [command, event]);
  return value;
}

/** The current time, ticking once a second while `live`, for elapsed times on cards. */
function useNow(live: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/** How a watched session reads as a card. */
function sessionView(s: SessionSummary) {
  return {
    role: roleOf(s.agent),
    state: sessionState(s),
    name: s.agent === "claude" ? "Claude" : "Gemini",
    line: activityText(s),
  };
}

export default function Pill() {
  const board = useBackend<BoardSnapshot>("board_snapshot", "board-updated", { sessions: [], feed: [] });
  const runs = useBackend<RunSummary[]>("runs_snapshot", "runs-updated", []);
  const approvals = useBackend<PendingApproval[]>("approvals_snapshot", "approvals-updated", []);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const collapseTimer = useRef<number>(undefined);
  const now = useNow(expanded);

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

  // Files and folders dragged onto the pill become attachments for the next goal.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter") {
        setDropping(true);
        expand();
      } else if (payload.type === "drop") {
        setDropping(false);
        setAttachments((current) => [...current, ...payload.paths.filter((p) => !current.includes(p))]);
      } else if (payload.type === "leave") {
        setDropping(false);
      }
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  const watched = board.sessions.filter((s) => s.status !== "idle");
  const cards = agentCards(runs, watched, approvals, sessionView);
  const counts = statusCounts(cards);
  const lead = mostUrgent(cards.map((c) => c.state));
  const crew = cards.filter((c) => c.active || c.state === "done").slice(0, 3);

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
    if (!prompt.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      await invoke<RunSummary>("start_task", { prompt, attachments });
      setPrompt("");
      setAttachments([]);
    } catch (err) {
      setError(String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="stage">
      <div
        className={`pill ${lead} ${expanded ? "expanded" : ""} ${details ? "detailed" : ""} ${dropping ? "dropping" : ""}`}
        onClick={expanded ? undefined : expand}
        onKeyDown={(e) => e.key === "Escape" && collapse()}
        role={expanded ? undefined : "button"}
        aria-label={expanded ? undefined : `Mission Control: ${STATE_LABEL[lead]}`}
      >
        <div className="pill-face">
          <BlobAvatar role="mc" state={lead} size={30} />
          {crew.length > 0 && (
            <span className="crew">
              {crew.map((c) => (
                <BlobAvatar key={c.key} role={c.role} state={c.state} size={18} />
              ))}
            </span>
          )}
        </div>

        {expanded && (
          <div className="panel">
            <div className="panel-main">
              <header className="panel-head">
                <BlobAvatar role="mc" state={lead} size={28} />
                <strong className="panel-name">Mission Control</strong>
                <button className="icon-button" onClick={() => invoke("open_dashboard")} aria-label="Open dashboard">
                  <Icon name="open" />
                </button>
                <button className="icon-button" onClick={collapse} aria-label="Collapse">
                  <Icon name="collapse" />
                </button>
              </header>

              {counts.needs + counts.working + counts.done > 0 && (
                <div className="status-chips">
                  {counts.needs > 0 && <span className="status-chip needs">{counts.needs} needs you</span>}
                  {counts.working > 0 && <span className="status-chip working">{counts.working} working</span>}
                  {counts.done > 0 && <span className="status-chip done">{counts.done} done</span>}
                </div>
              )}

              <div className="stack">
                {cards.map((card) => (
                  <StackCard key={card.key} card={card} now={now} />
                ))}
                {cards.length === 0 && <p className="empty">Nothing running. Type a goal, or drop a file or folder here.</p>}
              </div>

              {error && (
                <div className="pill-error" role="alert">
                  {error}
                  <button aria-label="Dismiss" onClick={() => setError(null)}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
              )}

              {attachments.length > 0 && (
                <ul className="attachments" aria-label="Attached files">
                  {attachments.map((path) => (
                    <li key={path} title={path}>
                      <Icon name="file" size={13} />
                      {fileName(path)}
                      <button aria-label={`Remove ${fileName(path)}`} onClick={() => setAttachments(attachments.filter((p) => p !== path))}>
                        <Icon name="x" size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <input
                  autoFocus
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={attachments.length > 0 ? "What should happen with these?" : "Type a goal, or drop a file or folder"}
                  aria-label="Goal"
                />
                <button className="send" type="submit" aria-label="Start" disabled={!prompt.trim() || starting}>
                  <Icon name="send" />
                </button>
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
                {watched.length === 0 && <p className="empty">Agents will show up here as they start work.</p>}
                {watched.map((s) => (
                  <AgentColumn key={`${s.agent}:${s.sessionId}`} session={s} />
                ))}
              </section>
            )}

            {dropping && (
              <div className="drop-target" aria-hidden="true">
                <BlobAvatar role="mc" state="thinking" size={64} />
                <strong>Drop to add as context</strong>
                <span>Files stay on this computer. Mission Control reads only what you drop.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One agent in the stack. Its size follows its state: an agent that needs you opens up with its
 * request, a working one shows progress, and a finished one shrinks to a line.
 */
function StackCard({ card, now }: { card: AgentCard; now: number }) {
  if (card.state === "needs") return <NeedsCard card={card} now={now} />;
  if (card.active) return <ActiveCard card={card} now={now} />;
  return <DoneCard card={card} />;
}

function CardHead({ card, now, sub, subClass }: { card: AgentCard; now: number; sub: string; subClass?: string }) {
  return (
    <div className="card-head">
      <BlobAvatar role={card.role} state={card.state} size={34} />
      <div className="card-title">
        <div>
          <strong>{card.name}</strong>
          {card.place && <span className="place">{card.place}</span>}
        </div>
        <span className={`card-sub ${subClass ?? ""}`} title={sub}>
          {sub}
        </span>
      </div>
      <span className="card-time">{elapsed(card.since, now)}</span>
    </div>
  );
}

function NeedsCard({ card, now }: { card: AgentCard; now: number }) {
  const [busy, setBusy] = useState(false);
  const request = card.approvals[0];

  async function answer(allow: boolean) {
    if (!request) return;
    setBusy(true);
    await invoke("answer_approval", { runId: request.runId, requestId: request.requestId, allow });
  }

  // A watched session can stall on a prompt in its own terminal, where only the user can answer.
  if (!request) {
    return (
      <article className="card needs">
        <CardHead card={card} now={now} sub="Waiting on you in its own terminal" subClass="needs" />
      </article>
    );
  }

  return (
    <article className="card needs" aria-label={`${card.name} needs your OK`}>
      <CardHead card={card} now={now} sub="Needs your OK to continue" subClass="needs" />
      <div className="request">
        <span className="request-tool">{request.label}</span>
        <span className="request-detail">{request.detail}</span>
        {request.description && <span className="request-why">{request.description}</span>}
      </div>
      <div className="card-actions">
        {card.approvals.length > 1 && <span className="more">+{card.approvals.length - 1} more after this</span>}
        <button className="deny" disabled={busy} onClick={() => answer(false)}>
          Deny
        </button>
        <button className="allow" disabled={busy} onClick={() => answer(true)}>
          Allow
        </button>
      </div>
    </article>
  );
}

function ActiveCard({ card, now }: { card: AgentCard; now: number }) {
  const run = card.run;
  return (
    <article className={`card active ${card.state}`}>
      <CardHead card={card} now={now} sub={card.line} />
      {run?.status === "starting" && <p className="card-note">{run.decision.reason}</p>}
      <div className="card-progress">
        <div className="progress" role="progressbar" aria-label={`${card.name} is ${card.line}`}>
          <span />
        </div>
        {run && (
          <button className="icon-button small" aria-label="Stop" onClick={() => invoke("cancel_task", { id: run.id })}>
            <Icon name="stop" size={12} />
          </button>
        )}
      </div>
    </article>
  );
}

function DoneCard({ card }: { card: AgentCard }) {
  const run = card.run;
  const link = run?.status === "finished" ? firstLink(run.result) : null;
  const failed = run?.status === "failed";
  return (
    <article className={`card compact ${failed ? "failed" : card.state}`} title={run?.result ?? card.line}>
      <BlobAvatar role={card.role} state={card.state} size={24} />
      <div className="compact-text">
        <strong>{card.name}</strong>
        <span>· {failed ? `Didn't finish. Log: ${run?.logPath}` : card.line}</span>
      </div>
      {link ? (
        <button className="open-link" onClick={() => openUrl(link)}>
          {linkLabel(link)}
        </button>
      ) : (
        !failed && card.state === "done" && <Icon name="check" className="done-check" />
      )}
    </article>
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

const ICONS = {
  open: "M9.5 2.5h4v4M13.5 2.5 8 8M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3",
  collapse: "M4 10l4-4 4 4",
  send: "M8 13V3M4 7l4-4 4 4",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  check: "M3.5 8.5l3 3 6-7",
  stop: "M4.5 4.5h7v7h-7z",
  file: "M4 1.5h5l3 3v10H4zM9 1.5v3h3",
};

/** Small stroke icons, drawn in the text colour. */
function Icon({ name, size = 16, className }: { name: keyof typeof ICONS; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** What the agent is on right now. "Thinking" is already the card's state, so show the prompt instead. */
function activityText(s: SessionSummary) {
  const activity = s.currentActivity === "Thinking" ? null : s.currentActivity;
  return activity ?? s.title ?? s.lastPrompt ?? "Waiting";
}

function projectName(path: string | null) {
  return path?.split(/[\\/]/).filter(Boolean).pop() ?? "";
}
