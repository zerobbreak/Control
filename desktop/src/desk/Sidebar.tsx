// The Desk's left column: the mark, the views, the agents (or recent runs), and what's playing.

import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import type { AvatarState } from "../avatar/blob";
import { Face, RoleGlyph } from "../Face";
import { Icon } from "../Icon";
import type { MediaAction, RunSummary, Settings } from "../types";
import { useNowPlaying } from "./actions";
import { agentRows, runStatusLabel, type DeskView } from "./desk";

type Props = {
  view: DeskView;
  onNavigate: (view: DeskView) => void;
  runs: RunSummary[];
  settings: Settings | null;
  waiting: number;
  lead: AvatarState;
  /** The run open in the run view, to mark it in the list. */
  openRunId: string | null;
};

const RECENT_RUNS = 10;

export function Sidebar({ view, onNavigate, runs, settings, waiting, lead, openRunId }: Props) {
  return (
    <nav className="desk-side" aria-label="Desk">
      <div className="desk-brand">
        <span className="desk-mark">
          <Face state={lead} small />
        </span>
        <span>Mission Control</span>
      </div>

      <div className="desk-nav">
        <NavItem current={view.kind === "today"} onClick={() => onNavigate({ kind: "today" })} icon={<SunIcon />} label="Today">
          {waiting > 0 && (
            <span className="desk-nav-badge" aria-label={`${waiting} waiting on you`}>
              {waiting}
            </span>
          )}
        </NavItem>
        <NavItem current={view.kind === "run"} onClick={() => onNavigate({ kind: "run", runId: null })} icon={<Icon name="tasks" />} label="Runs" />
        <NavItem current={view.kind === "changes"} onClick={() => onNavigate({ kind: "changes" })} icon={<Icon name="branch" />} label="Changes" />
        <NavItem current={view.kind === "boundaries"} onClick={() => onNavigate({ kind: "boundaries" })} icon={<Icon name="shield" />} label="Boundaries" />
      </div>

      {view.kind === "run" ? (
        <div className="desk-side-section">
          <span className="mc-label desk-side-label">Recent runs</span>
          {runs.length === 0 && <span className="desk-side-empty">No runs yet</span>}
          {runs.slice(0, RECENT_RUNS).map((run) => {
            const status = runStatusLabel(run.status);
            return (
              <button
                key={run.id}
                className={`desk-recent${run.id === openRunId ? " on" : ""}`}
                aria-current={run.id === openRunId ? "page" : undefined}
                onClick={() => onNavigate({ kind: "run", runId: run.id })}
              >
                <span className="desk-recent-goal">{run.goal}</span>
                <span className={`desk-recent-status tone-${status.tone}`}>{status.label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="desk-side-section desk-agents">
          <span className="mc-label">Agents</span>
          {agentRows(runs, settings).map((row) => (
            <div key={row.role} className="desk-agent">
              <span className="desk-agent-glyph">
                <RoleGlyph role={row.role} color={row.tone === "idle" || row.tone === "off" ? "var(--muted)" : `var(--${row.tone})`} size={12} />
              </span>
              {row.name}
              {row.tone === "idle" || row.tone === "off" ? (
                <span className="desk-agent-note">{row.tone}</span>
              ) : (
                <span className={`desk-dot tone-${row.tone}`} role="img" aria-label={row.tone === "needs" ? "Needs you" : "Working"} />
              )}
            </div>
          ))}
        </div>
      )}

      <span className="desk-side-fill" />

      {settings?.capabilities.mediaControls === true && <MiniPlayer />}

      <div className="desk-runtime mc-mono">
        <span className="desk-dot tone-done small" />
        Runtime on this PC
      </div>
    </nav>
  );
}

function NavItem({ current, onClick, icon, label, children }: { current: boolean; onClick: () => void; icon: ReactNode; label: string; children?: ReactNode }) {
  return (
    <button className={`desk-nav-item${current ? " on" : ""}`} aria-current={current ? "page" : undefined} onClick={onClick}>
      {icon}
      {label}
      {children}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

/** What's playing on the computer, with the same controls as the island. */
function MiniPlayer() {
  const media = useNowPlaying(true);
  if (!media) return null;
  const control = (action: MediaAction) => invoke("media_control", { action }).catch(() => undefined);
  return (
    <div className="desk-player">
      <div className="desk-player-now">
        <span className={`desk-player-bars${media.playing ? " playing" : ""}`} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <div className="desk-player-text">
          <span className="desk-player-title">{media.title}</span>
          <span className="desk-player-sub">{[media.artist, media.app].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
      <div className="desk-player-controls">
        <button aria-label="Previous" onClick={() => control("previous")}>
          <Icon name="next" size={14} className="flip" />
        </button>
        <button className="main" aria-label={media.playing ? "Pause" : "Play"} onClick={() => control("playPause")}>
          <Icon name={media.playing ? "pause" : "play"} size={14} />
        </button>
        <button aria-label="Next" onClick={() => control("next")}>
          <Icon name="next" size={14} />
        </button>
        <button aria-label="Volume down" onClick={() => control("volumeDown")}>
          <Icon name="volumeDown" size={15} />
        </button>
        <button aria-label="Volume up" onClick={() => control("volumeUp")}>
          <Icon name="volumeUp" size={15} />
        </button>
      </div>
    </div>
  );
}
