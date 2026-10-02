import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentEvent, BoardSnapshot, SessionStatus, SessionSummary } from "./types";
import "./App.css";

const STATUS_LABEL: Record<SessionStatus, string> = {
  working: "Working",
  stalled: "Stalled",
  waitingForUser: "Waiting for you",
  idle: "Idle",
};

function App() {
  const [prompt, setPrompt] = useState("");
  const [board, setBoard] = useState<BoardSnapshot>({ sessions: [], feed: [] });
  const [showIdle, setShowIdle] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    invoke<BoardSnapshot>("board_snapshot").then(setBoard);
    const unlisten = listen<BoardSnapshot>("board-updated", (e) => setBoard(e.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  async function startTask(prompt: string) {
    const response = await invoke<string>("start_task", { prompt });
    console.log(response);
  }

  const sessions = board.sessions.filter((s) => showIdle || s.status !== "idle");
  const feed = useMemo(
    () => board.feed.filter((e) => !selected || e.sessionId === selected).slice(0, 80),
    [board.feed, selected],
  );
  const counts = board.sessions.reduce<Record<SessionStatus, number>>(
    (acc, s) => ({ ...acc, [s.status]: acc[s.status] + 1 }),
    { working: 0, stalled: 0, waitingForUser: 0, idle: 0 },
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1>Mission Control</h1>
        <div className="counts">
          <span className="count working">{counts.working} working</span>
          <span className="count stalled">{counts.stalled} stalled</span>
          <span className="count waitingForUser">{counts.waitingForUser} waiting</span>
        </div>
        <form
          className="task"
          onSubmit={(e) => {
            e.preventDefault();
            startTask(prompt);
          }}
        >
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Give Mission Control a task…"
          />
          <button type="submit">Run</button>
        </form>
      </header>

      <main className="layout">
        <section className="sessions">
          <div className="section-head">
            <h2>Agents</h2>
            <label>
              <input type="checkbox" checked={showIdle} onChange={(e) => setShowIdle(e.target.checked)} />
              Show idle
            </label>
          </div>
          {sessions.length === 0 && (
            <p className="empty">No active Claude Code or Gemini CLI sessions in the last 15 minutes.</p>
          )}
          {sessions.map((s) => (
            <SessionCard
              key={`${s.agent}:${s.sessionId}`}
              session={s}
              selected={selected === s.sessionId}
              onSelect={() => setSelected(selected === s.sessionId ? null : s.sessionId)}
            />
          ))}
        </section>

        <section className="feed">
          <div className="section-head">
            <h2>{selected ? "Session activity" : "Live activity"}</h2>
            {selected && <button className="link" onClick={() => setSelected(null)}>Show all</button>}
          </div>
          <ol>
            {feed.map((e, i) => (
              <FeedItem key={`${e.sessionId}:${e.timestamp}:${i}`} event={e} />
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}

function SessionCard({
  session: s,
  selected,
  onSelect,
}: {
  session: SessionSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`card ${s.status} ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="card-head">
        <span className={`agent ${s.agent}`}>{s.agent === "claude" ? "Claude Code" : "Gemini CLI"}</span>
        <span className={`status ${s.status}`}>{STATUS_LABEL[s.status]}</span>
      </div>
      <div className="title">{s.title ?? s.lastPrompt ?? "Untitled session"}</div>
      <div className="project" title={s.project ?? undefined}>{shortPath(s.project)}</div>
      {s.currentActivity && <div className="activity">▸ {s.currentActivity}</div>}
      {!s.currentActivity && s.lastMessage && <div className="message">{s.lastMessage}</div>}
      <div className="meta">
        <span>{s.toolCalls} tool calls</span>
        {s.toolErrors > 0 && <span className="errors">{s.toolErrors} failed</span>}
        <span>{timeAgo(s.lastActivity)}</span>
      </div>
    </button>
  );
}

function FeedItem({ event: e }: { event: AgentEvent }) {
  const { kind } = e;
  let icon = "•";
  let text = "";
  switch (kind.type) {
    case "userPrompt":
      icon = "›";
      text = kind.text;
      break;
    case "assistantText":
      icon = kind.turnFinished ? "✓" : "…";
      text = kind.text;
      break;
    case "toolCall":
      icon = "⚙";
      text = kind.summary ? `${kind.tool} · ${kind.summary}` : kind.tool;
      break;
    case "toolResult":
      if (!kind.isError) return null;
      icon = "✗";
      text = "Tool call failed";
      break;
    case "error":
      icon = "✗";
      text = kind.message;
      break;
    case "title":
      return null;
  }
  return (
    <li className={`feed-item ${kind.type}`}>
      <span className="icon">{icon}</span>
      <span className="text">{text}</span>
      <span className="when">{new Date(e.timestamp).toLocaleTimeString()}</span>
    </li>
  );
}

function shortPath(path: string | null) {
  if (!path) return "Unknown project";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

function timeAgo(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export default App;
