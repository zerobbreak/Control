// Today: what is waiting on you, what is running, what finished, and the goal box.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { recycleSuggestions } from "../capabilities";
import { RoleGlyph } from "../Face";
import { Icon } from "../Icon";
import { connectionLabel, elapsed, firstLine, firstLink, linkLabel, otherSessions, runPlace, runRole } from "../runs";
import type { App, BoardSnapshot, PendingApproval, RunSummary, Settings } from "../types";
import { answerApproval, saveSettings } from "./actions";
import { Composer } from "./Composer";
import {
  actionCount,
  agentLabel,
  appAccessLabel,
  approvalTitle,
  autonomyLabel,
  currentAction,
  dayLabel,
  doneToday,
  greeting,
  isCommand,
  runEvents,
  runPhases,
  sessionTitle,
  sessionTone,
  spendLabel,
  statusLine,
  tierLabel,
  watchedLine,
  type DeskView,
} from "./desk";
import { RecycleAction } from "./Recycle";

const CONNECTORS_URL = "https://claude.ai/settings/connectors";
const WATCHED = 5;

type Props = {
  runs: RunSummary[];
  approvals: PendingApproval[];
  board: BoardSnapshot;
  settings: Settings | null;
  now: number;
  onNavigate: (view: DeskView) => void;
  dropped: { key: number; paths: string[] } | null;
  dragging: boolean;
  onDropTaken: () => void;
};

export function Today({ runs, approvals, board, settings, now, onNavigate, dropped, dragging, onDropTaken }: Props) {
  const active = runs.filter((r) => r.status === "starting" || r.status === "running" || r.status === "needsApproval");
  const done = doneToday(runs, now);
  const openRun = (id: string) => onNavigate({ kind: "run", runId: id });
  const date = new Date(now);

  return (
    <div className="page">
      <header className="today-head">
        <div className="today-title">
          <span className="today-date">{dayLabel(date)}</span>
          <h1>
            {greeting(date.getHours())}. {statusLine(active.length, approvals.length)}
          </h1>
        </div>
        <Composer settings={settings} dropped={dropped} dragging={dragging} onDropTaken={onDropTaken} onStarted={(run) => openRun(run.id)} />
      </header>

      <div className="columns">
        <div className="columns-main">
          {approvals.length > 0 && (
            <section className="stack" aria-labelledby="needs-you">
              <div className="section-head">
                <h2 id="needs-you" className="mc-label tone-needs">
                  Needs you
                </h2>
                <span className="section-count">{approvals.length}</span>
              </div>
              {approvals.map((request) => (
                <NeedsCard key={request.requestId} request={request} run={runs.find((r) => r.id === request.runId)} onOpen={openRun} />
              ))}
            </section>
          )}

          {active.length > 0 && (
            <section className="stack" aria-labelledby="in-progress">
              <h2 id="in-progress" className="mc-label">
                In progress
              </h2>
              {active.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  board={board}
                  request={approvals.find((a) => a.runId === run.id)}
                  now={now}
                  onOpen={() => openRun(run.id)}
                />
              ))}
            </section>
          )}

          {done.length > 0 && (
            <section className="stack" aria-labelledby="done-today">
              <h2 id="done-today" className="mc-label">
                Done today
              </h2>
              <div className="panel list">
                {done.map((run) => (
                  <DoneRow key={run.id} run={run} settings={settings} onOpen={() => openRun(run.id)} />
                ))}
              </div>
            </section>
          )}

          {approvals.length + active.length + done.length === 0 && (
            <p className="quiet-empty">Goals you hand over show up here while they run, with what they found when they finish.</p>
          )}
        </div>

        <aside className="columns-side">
          {settings?.watchOtherSessions !== false && <AlsoWatching board={board} runs={runs} now={now} />}
          <YourApps settings={settings} onManage={() => onNavigate({ kind: "boundaries" })} />
          {settings && <Limits settings={settings} onManage={() => onNavigate({ kind: "boundaries" })} />}
        </aside>
      </div>
    </div>
  );
}

function RoleTile({ run, size = "m" }: { run: RunSummary | undefined; size?: "m" | "l" }) {
  const role = run ? runRole(run) : "code";
  return (
    <span className={`tile role-${role} ${size}`} aria-hidden="true">
      <RoleGlyph role={role} color="currentColor" size={size === "l" ? 14 : 12} />
    </span>
  );
}

function NeedsCard({ request, run, onOpen }: { request: PendingApproval; run: RunSummary | undefined; onOpen: (id: string) => void }) {
  const [answering, setAnswering] = useState(false);
  const answer = async (allow: boolean) => {
    setAnswering(true);
    try {
      await answerApproval(request, allow);
    } finally {
      setAnswering(false);
    }
  };
  const place = run ? runPlace(run) : "your project";
  return (
    <div className="needs-card">
      <RoleTile run={run} size="l" />
      <div className="needs-text">
        <button className="title-link" onClick={() => onOpen(request.runId)}>
          {approvalTitle(request, place)}
        </button>
        <span className={isCommand(request.tool) ? "needs-detail mc-mono" : "needs-detail"}>{request.detail}</span>
        {request.description && <span className="needs-why">{request.description}</span>}
      </div>
      <div className="row-actions">
        <button className="btn needs-deny" disabled={answering} onClick={() => answer(false)}>
          Deny
        </button>
        <button className="btn allow" disabled={answering} onClick={() => answer(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}

function RunCard({
  run,
  board,
  request,
  now,
  onOpen,
}: {
  run: RunSummary;
  board: BoardSnapshot;
  request: PendingApproval | undefined;
  now: number;
  onOpen: () => void;
}) {
  const events = runEvents(board.feed, run.id);
  const phases = runPhases(run, events, request !== undefined);
  const actions = actionCount(events);
  const doing = request
    ? null
    : run.status === "starting"
      ? run.decision.task === "assistant"
        ? "Connecting to your apps…"
        : "Starting…"
      : currentAction(events) ?? "Working";

  return (
    <button className="run-card" onClick={onOpen}>
      <div className="run-card-head">
        <RoleTile run={run} />
        <div className="run-card-title">
          <span className="run-card-goal">{run.goal}</span>
          <span className="run-card-meta">
            {agentLabel(run)} · {runPlace(run)} · {tierLabel(run.decision.tier)}
          </span>
        </div>
        <span className="run-card-time mc-mono">{elapsed(run.startedAt, now)}</span>
      </div>

      <div className="phases" role="img" aria-label={phases.map((p) => `${p.label}: ${p.state === "todo" ? "not yet" : p.state === "done" ? "done" : p.state === "needs" ? "waiting on you" : "now"}`).join(", ")}>
        {phases.map((p) => (
          <span key={p.label} className={`phase ${p.state}`} title={p.label} />
        ))}
      </div>

      {run.connections.length > 0 && (
        <div className="chips">
          {run.connections.map((c) => {
            const label = connectionLabel(c.status);
            return (
              <span key={c.name} className={`chip conn ${label.tone}`} title={label.label}>
                {label.tone === "done" && <Icon name="check" size={11} />}
                {c.name}
              </span>
            );
          })}
        </div>
      )}

      <div className="run-card-now">
        <span className={`desk-dot small tone-${request ? "needs" : "working"}`} />
        {request ? (
          <span className="run-card-doing">
            {isCommand(request.tool) ? "Waiting to run " : `Waiting to use ${request.label}: `}
            <span className="mc-mono strong">{request.detail}</span>
          </span>
        ) : (
          <span className="run-card-doing">{doing}</span>
        )}
        {actions > 0 && (
          <span className="run-card-count">
            {actions} action{actions === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </button>
  );
}

function DoneRow({ run, settings, onOpen }: { run: RunSummary; settings: Settings | null; onOpen: () => void }) {
  const { text, paths } = recycleSuggestions(run.result);
  const link = firstLink(text);
  const summary =
    run.status === "failed"
      ? `Didn't finish${run.exitCode !== null ? ` · exit code ${run.exitCode}` : ""}. Open it to see the log.`
      : run.status === "cancelled"
        ? "You stopped it."
        : firstLine(text) ?? "Done";
  const allowRecycling = (allowed: boolean) => {
    if (settings) saveSettings({ ...settings, capabilities: { ...settings.capabilities, recycleFiles: allowed } });
  };

  return (
    <div className="done-row">
      <span className={`done-mark tone-${run.status === "finished" ? "done" : run.status === "failed" ? "failed" : "idle"}`} aria-hidden="true">
        <Icon name={run.status === "finished" ? "check" : run.status === "failed" ? "x" : "stop"} size={16} />
      </span>
      <div className="done-text">
        <button className="title-link small" onClick={onOpen}>
          {run.goal}
        </button>
        <span className="done-summary">{summary}</span>
      </div>
      {run.status === "finished" && paths.length > 0 ? (
        <RecycleAction run={run} paths={paths} allowed={settings?.capabilities.recycleFiles ?? null} onAllow={allowRecycling} />
      ) : link ? (
        <button className="btn soft" onClick={() => openUrl(link)}>
          <Icon name="open" size={13} />
          {linkLabel(link)}
        </button>
      ) : (
        <span className="done-meta mc-mono">
          {run.decision.task === "browse" ? "Browser" : `${tierLabel(run.decision.tier)} · ${run.decision.access === "readOnly" ? "read only" : run.decision.access === "useApps" ? "your apps" : "edits"}`}
        </span>
      )}
    </div>
  );
}

function AlsoWatching({ board, runs, now }: { board: BoardSnapshot; runs: RunSummary[]; now: number }) {
  const sessions = otherSessions(board.sessions, runs)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(a.s.status === "idle") - Number(b.s.status === "idle") || a.i - b.i)
    .slice(0, WATCHED)
    .map(({ s }) => s);
  if (sessions.length === 0) return null;
  return (
    <section className="stack" aria-labelledby="also-watching">
      <h2 id="also-watching" className="mc-label">
        Also watching
      </h2>
      {sessions.map((s) => (
        <div key={`${s.agent}:${s.sessionId}`} className="panel watched">
          <div className="watched-head">
            <span className={`desk-dot tone-${sessionTone(s)}`} aria-hidden="true" />
            <span className="watched-title">{sessionTitle(s)}</span>
          </div>
          <span className="watched-line">{watchedLine(s, now)}</span>
        </div>
      ))}
    </section>
  );
}

const APP_TINTS = ["neutral", "failed", "working", "done", "needs"];

/** Each app's letter tile gets a steady tint from its name. */
function tint(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return APP_TINTS[hash % APP_TINTS.length];
}

function YourApps({ settings, onManage }: { settings: Settings | null; onManage: () => void }) {
  const [apps, setApps] = useState<App[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Listing apps asks Claude Code for its connectors, which takes a few seconds.
  useEffect(() => {
    invoke<App[]>("list_apps").then(setApps, (err) => setError(String(err)));
  }, []);

  return (
    <section className="stack" aria-labelledby="your-apps">
      <div className="section-head spread">
        <h2 id="your-apps" className="mc-label">
          Your apps
        </h2>
        <button className="text-link" onClick={onManage}>
          Manage
        </button>
      </div>
      <div className="panel list">
        {apps === null && !error && (
          <div className="app-row muted" aria-live="polite">
            Checking your apps…
          </div>
        )}
        {error && <div className="app-row muted">Couldn't list your apps</div>}
        {apps?.length === 0 && <div className="app-row muted">No apps connected</div>}
        {apps?.map((app) => (
          <div key={app.id} className="app-row">
            <span className={`app-tile tint-${tint(app.name)}`} aria-hidden="true">
              {app.name.charAt(0).toUpperCase()}
            </span>
            {app.name}
            {app.status === "needsAuth" ? (
              <button className="text-link needs" onClick={() => openUrl(CONNECTORS_URL)}>
                Sign in
              </button>
            ) : app.status === "failed" ? (
              <span className="app-access failed">Couldn't connect</span>
            ) : (
              <span className="app-access">{appAccessLabel(settings?.appAccess[app.id])}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Limits({ settings, onManage }: { settings: Settings; onManage: () => void }) {
  return (
    <section className="stack" aria-labelledby="limits">
      <div className="section-head spread">
        <h2 id="limits" className="mc-label">
          Limits
        </h2>
        <button className="text-link" onClick={onManage}>
          Change
        </button>
      </div>
      <dl className="panel facts">
        <div>
          <dt>Strongest model</dt>
          <dd>{tierLabel(settings.maxTier)}</dd>
        </div>
        <div>
          <dt>Spend per run</dt>
          <dd>{spendLabel(settings.maxBudgetUsd)}</dd>
        </div>
        <div>
          <dt>Autonomy</dt>
          <dd>{autonomyLabel(settings)}</dd>
        </div>
      </dl>
    </section>
  );
}
