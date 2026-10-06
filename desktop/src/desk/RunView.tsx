// One run: its goal, how it was set up, and a timeline of what the agent did, built from the
// board's feed for its session, with any request waiting on you inline.

import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { recycleSuggestions } from "../capabilities";
import { RoleGlyph } from "../Face";
import { Icon } from "../Icon";
import { agentName, connectionLabel, firstLink, isActive, linkLabel, runPlace, runRole, toolName } from "../runs";
import type { BoardSnapshot, PendingApproval, RunSummary, Settings } from "../types";
import { alwaysAllow, answerApproval, saveSettings } from "./actions";
import {
  accessLabel,
  agentLabel,
  alwaysAllowPrefix,
  buildTimeline,
  changedFiles,
  clockTime,
  durationLabel,
  groupLabel,
  isCommand,
  relativePath,
  runEvents,
  runStatusLabel,
  tierLabel,
  type DeskView,
  type TimelineItem,
  type ToolKind,
} from "./desk";
import { RecycleAction } from "./Recycle";

type Props = {
  run: RunSummary | undefined;
  board: BoardSnapshot;
  approvals: PendingApproval[];
  settings: Settings | null;
  now: number;
  onNavigate: (view: DeskView) => void;
};

/** Calls shown in a group before "and N more". */
const SHOWN_CALLS = 3;

export function RunView({ run, board, approvals, settings, now, onNavigate }: Props) {
  if (!run) {
    return (
      <div className="page">
        <div className="quiet-empty">
          <p>No run to show yet. Give Mission Control a goal from Today and it shows up here as it works.</p>
          <button className="btn" onClick={() => onNavigate({ kind: "today" })}>
            Go to Today
          </button>
        </div>
      </div>
    );
  }

  const events = runEvents(board.feed, run.id);
  const timeline = buildTimeline(events);
  const pending = approvals.filter((a) => a.runId === run.id);
  const changed = changedFiles(events, run.workdir);
  const status = runStatusLabel(run.status);
  const role = runRole(run);

  return (
    <div className="page">
      <header className="run-head">
        <nav className="crumbs" aria-label="Breadcrumb">
          <button className="text-link muted" onClick={() => onNavigate({ kind: "today" })}>
            Runs
          </button>
          <span aria-hidden="true">/</span>
          <span>{runPlace(run)}</span>
        </nav>
        <div className="run-title-row">
          <h1>{run.goal}</h1>
          <div className="row-actions">
            <button className="btn outline" onClick={() => revealItemInDir(run.logPath)}>
              Open log
            </button>
            {isActive(run) && (
              <button className="btn stop" onClick={() => invoke("cancel_task", { id: run.id })}>
                Stop run
              </button>
            )}
          </div>
        </div>
        <div className="chips">
          <span className={`chip status tone-${status.tone}`}>
            <span className={`desk-dot small tone-${status.tone}`} aria-hidden="true" />
            {status.label}
          </span>
          <span className="chip">
            <RoleGlyph role={role} size={11} />
            {agentLabel(run)}
          </span>
          <span className="chip">
            {tierLabel(run.decision.tier)} · {run.model}
          </span>
          <span className="chip">{accessLabel(run.decision.access)}</span>
          <span className="chip mc-mono" title={run.workdir}>
            {run.workdir}
          </span>
          <span className="chip">
            Started {clockTime(run.startedAt)} · {durationLabel(run.startedAt, run.endedAt ? new Date(run.endedAt).getTime() : now)}
          </span>
        </div>
      </header>

      <div className="columns">
        <section className="columns-main timeline" aria-label="What the agent did">
          <Step dot="person" label={`You · ${clockTime(run.startedAt)}`}>
            <HandedOver run={run} />
          </Step>

          {run.connections.length > 0 && (
            <Step dot="neutral" icon="apps" label="Connected to your apps">
              <div className="chips">
                {run.connections.map((c) => {
                  const label = connectionLabel(c.status);
                  return (
                    <span key={c.name} className={`chip conn ${label.tone}`}>
                      {label.tone === "done" && <Icon name="check" size={11} />}
                      {c.name} · {label.label}
                    </span>
                  );
                })}
              </div>
            </Step>
          )}

          {timeline.map((item, i) => (
            <TimelineStep key={`${item.at}:${i}`} item={item} run={run} />
          ))}

          {pending.map((request) => (
            <PendingStep key={request.requestId} request={request} run={run} settings={settings} />
          ))}

          <Ending run={run} settings={settings} />
        </section>

        <aside className="columns-side">
          {run.decision.reason && (
            <section className="panel side-card">
              <h2 className="mc-label">Why this agent</h2>
              <p className="side-text">{run.decision.reason}</p>
            </section>
          )}
          <section className="panel side-card">
            <h2 className="mc-label">Permissions</h2>
            <dl className="facts plain">
              <div>
                <dt>Allowed by your rules</dt>
                <dd>{run.autoAllowed}</dd>
              </div>
              <div>
                <dt>Asking you now</dt>
                <dd>{pending.length}</dd>
              </div>
              <div>
                <dt>Refused by your rules</dt>
                <dd>{run.autoDenied}</dd>
              </div>
            </dl>
          </section>
          {changed.length > 0 && (
            <section className="panel side-card">
              <div className="section-head spread">
                <h2 className="mc-label">{isActive(run) ? "Changed so far" : "Changed"}</h2>
                <button className="text-link" onClick={() => onNavigate({ kind: "changes" })}>
                  Review
                </button>
              </div>
              <ul className="changed-files">
                {changed.map((file) => (
                  <li key={file} className="mc-mono" title={file}>
                    {file}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

type Dot = "person" | "neutral" | "working" | "failed" | "needs" | "done";

function Step({ dot, icon, label, children }: { dot: Dot; icon?: Parameters<typeof Icon>[0]["name"]; label?: string; children: ReactNode }) {
  return (
    <div className="step">
      <div className="step-rail" aria-hidden="true">
        <span className={`step-dot ${dot}`}>
          {dot === "person" ? <PersonIcon /> : dot === "needs" ? <span className="bang">!</span> : icon ? <Icon name={icon} size={12} /> : null}
        </span>
        <span className="step-line" />
      </div>
      <div className="step-body">
        {label && <span className="step-label">{label}</span>}
        {children}
      </div>
    </div>
  );
}

function PersonIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1-4 4-6 8-6s7 2 8 6" />
    </svg>
  );
}

/** "Handed over Lumina and login-bug.png with the goal." */
function HandedOver({ run }: { run: RunSummary }) {
  const names = [
    ...(run.decision.task === "code" || run.decision.task === "question" ? [runPlace(run)] : []),
    ...run.attachments.map((a) => a.split(/[\\/]/).filter(Boolean).pop() ?? a),
  ];
  const unique = [...new Set(names)];
  if (unique.length === 0) return <span className="step-text">Gave {agentName(run) === "Claude" ? "Claude" : `the ${agentName(run).toLowerCase()}`} the goal.</span>;
  return (
    <span className="step-text">
      Handed over{" "}
      {unique.map((name, i) => (
        <span key={name}>
          {i > 0 && (i === unique.length - 1 ? " and " : ", ")}
          <b>{name}</b>
        </span>
      ))}{" "}
      with the goal.
    </span>
  );
}

const TOOL_ICON: Record<ToolKind, Parameters<typeof Icon>[0]["name"]> = {
  read: "prompt",
  edit: "code",
  command: "terminal",
  app: "apps",
  other: "tasks",
};

function TimelineStep({ item, run }: { item: TimelineItem; run: RunSummary }) {
  const time = clockTime(item.at);
  switch (item.type) {
    case "prompt":
      // The first prompt is the goal itself, already the page's title.
      if (item.first) return null;
      return (
        <Step dot="person" label={`You · ${time}`}>
          <span className="step-text pre">{item.text}</span>
        </Step>
      );
    case "text":
      return (
        <Step dot="neutral" icon="reply" label={`${agentName(run)} · ${time}`}>
          <span className="step-text said pre">{item.text}</span>
        </Step>
      );
    case "error":
      return (
        <Step dot="failed" icon="x" label={`Something went wrong · ${time}`}>
          <span className="step-text failed-text">{item.message}</span>
        </Step>
      );
    case "tools":
      return <ToolGroup item={item} time={time} workdir={run.workdir} />;
  }
}

function ToolGroup({ item, time, workdir }: { item: Extract<TimelineItem, { type: "tools" }>; time: string; workdir: string }) {
  const [open, setOpen] = useState(false);
  const failed = item.calls.some((c) => c.failed);
  const shown = open ? item.calls : item.calls.slice(0, SHOWN_CALLS);
  const hidden = item.calls.length - shown.length;
  return (
    <Step dot={failed ? "failed" : "working"} icon={failed ? "x" : TOOL_ICON[item.kind]} label={`${groupLabel(item)} · ${time}`}>
      <div className="calls">
        {shown.map((call, i) => (
          <span key={i} className={`call mc-mono${call.failed ? " failed" : ""}`}>
            <span className="call-tool">{toolName(call.tool)}</span>
            <span className="call-summary">{relativePath(call.summary, workdir)}</span>
            {call.failed && <span className="call-failed">failed</span>}
          </span>
        ))}
        {hidden > 0 && (
          <button className="text-link muted small" onClick={() => setOpen(true)}>
            and {hidden} more
          </button>
        )}
        {open && item.calls.length > SHOWN_CALLS && (
          <button className="text-link muted small" onClick={() => setOpen(false)}>
            Show fewer
          </button>
        )}
      </div>
    </Step>
  );
}

function PendingStep({ request, run, settings }: { request: PendingApproval; run: RunSummary; settings: Settings | null }) {
  const [answering, setAnswering] = useState(false);
  const prefix = alwaysAllowPrefix(request.tool, request.detail);
  const act = async (action: () => Promise<unknown>) => {
    setAnswering(true);
    try {
      await action();
    } finally {
      setAnswering(false);
    }
  };
  return (
    <Step dot="needs">
      <div className="pending">
        <span className="pending-when">Waiting on you · {clockTime(request.askedAt)}</span>
        <span className="pending-ask">
          {isCommand(request.tool) ? (
            <>
              Run <span className="mc-mono">{request.detail}</span> in {runPlace(run)}?
            </>
          ) : (
            <>
              {request.label}: <span className="mc-mono">{request.detail}</span>?
            </>
          )}
        </span>
        {request.description && <span className="pending-why">{request.description}</span>}
        <div className="row-actions">
          <button className="btn needs-deny" disabled={answering} onClick={() => act(() => answerApproval(request, false))}>
            Deny
          </button>
          <button className="btn allow" disabled={answering} onClick={() => act(() => answerApproval(request, true))}>
            Allow
          </button>
          {prefix && settings && (
            <button className="btn ghost" disabled={answering} onClick={() => act(() => alwaysAllow(settings, request, prefix))}>
              Always allow {prefix}
            </button>
          )}
        </div>
      </div>
    </Step>
  );
}

/** How the run ended, with its answer and anything it suggests doing next. */
function Ending({ run, settings }: { run: RunSummary; settings: Settings | null }) {
  if (isActive(run)) return null;
  const { text, paths } = recycleSuggestions(run.result);
  const link = firstLink(text);
  const when = run.endedAt ? clockTime(run.endedAt) : "";
  if (run.status === "cancelled") {
    return (
      <Step dot="neutral" icon="stop" label={`Stopped · ${when}`}>
        <span className="step-text">You stopped it.</span>
      </Step>
    );
  }
  if (run.status === "failed") {
    return (
      <Step dot="failed" icon="x" label={`Didn't finish · ${when}`}>
        <span className="step-text">
          The agent stopped{run.exitCode !== null ? ` with exit code ${run.exitCode}` : ""}. The log has the details.
        </span>
      </Step>
    );
  }
  return (
    <Step dot="done" icon="check" label={`Done · ${when}`}>
      {text && <span className="step-text said pre">{text}</span>}
      {(link || paths.length > 0) && (
        <div className="row-actions">
          {link && (
            <button className="btn soft" onClick={() => openUrl(link)}>
              <Icon name="open" size={13} />
              {linkLabel(link)}
            </button>
          )}
          {paths.length > 0 && (
            <RecycleAction
              run={run}
              paths={paths}
              allowed={settings?.capabilities.recycleFiles ?? null}
              onAllow={(allowed) => settings && saveSettings({ ...settings, capabilities: { ...settings.capabilities, recycleFiles: allowed } })}
            />
          )}
        </div>
      )}
    </Step>
  );
}
