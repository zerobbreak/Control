// The island's small cards, one per moment: an agent at work, a request waiting on you, a result,
// and a drop in progress. Each is a header line, a title, one detail line and a row of buttons.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Face, RoleGlyph } from "../Face";
import { Icon } from "../Icon";
import { progressSteps, STATE_LABEL } from "../avatar/pillState";
import { recycleSuggestions } from "../capabilities";
import { contextCounts } from "../context";
import {
  agentName,
  elapsed,
  firstLine,
  firstLink,
  linkLabel,
  resultHeadline,
  tileLine,
  type AgentCard,
} from "../runs";
import type { AgentEvent, ContextItem, PendingApproval, RunSummary } from "../types";
import { connectingNote, currentAction, failReason, rememberRule, requestWords, resultSummary, ruleCounts, took, type Remember } from "./island";

const STATE_COLOR = { idle: "var(--faint)", thinking: "var(--text-2)", working: "var(--working)", needs: "var(--needs)", done: "var(--done)" };

/** Other busy agents, one line each, under the lead's card. */
function OthersList({ others, feed }: { others: AgentCard[]; feed: AgentEvent[] }) {
  if (others.length === 0) return null;
  return (
    <ul className="others" aria-label="Other agents">
      {others.map((c) => (
        <li key={c.key} className={c.state}>
          <RoleGlyph role={c.role} color={STATE_COLOR[c.state]} size={11} />
          <span className="one-line">
            {c.name} · {c.state === "needs" ? STATE_LABEL.needs.toLowerCase() : tileLine(c, feed)}
          </span>
        </li>
      ))}
    </ul>
  );
}

type WorkProps = {
  card: AgentCard;
  others: AgentCard[];
  feed: AgentEvent[];
  now: number;
  onDesk: (view: string) => void;
  onNew: () => void;
};

/** The lead agent at work: what it is on, how far along its turn is, and the others beside it. */
export function WorkCard({ card, others, feed, now, onDesk, onNew }: WorkProps) {
  const run = card.run;
  const action = currentAction(card, feed);
  const note = run?.status === "starting" ? connectingNote(run.connections) : null;
  const title = run?.goal ?? card.session?.title ?? card.session?.lastPrompt ?? card.name;
  return (
    <section className={`card ${card.state}`} aria-label={`${card.name} ${STATE_LABEL[card.state].toLowerCase()}`}>
      <header className="card-head">
        <Face state={card.state} role={card.role} />
        <span className="card-tag working one-line">
          {STATE_LABEL[card.state]}
          {card.place ? ` · ${card.place}` : ""}
        </span>
        <span className="card-meta mono">{elapsed(card.since, now)}</span>
        <button className="icon-btn" aria-label="New goal" title="New goal" onClick={onNew}>
          <Icon name="plus" size={13} />
        </button>
      </header>
      <div className="card-body">
        <strong className="card-title one-line" title={title}>
          {title}
        </strong>
        <span className="card-detail one-line" title={`${action.verb} ${action.object}`}>
          {action.verb} {action.object && <span className="mono">{action.object}</span>}
        </span>
        {note && <span className="card-note">{note}</span>}
      </div>
      <div className="progress" role="img" aria-label={`Step: ${STATE_LABEL[card.state]}`}>
        {progressSteps(card.state).map((step) => (
          <span key={step.label} className={step.status} />
        ))}
      </div>
      <OthersList others={others} feed={feed} />
      <div className="card-actions">
        {run && card.active && (
          <button className="btn stop" onClick={() => invoke("cancel_task", { id: run.id })}>
            Stop
          </button>
        )}
        <button className="btn" onClick={() => onDesk(run ? `run:${run.id}` : "today")}>
          Open in Desk
        </button>
      </div>
    </section>
  );
}

type ApprovalProps = {
  approvals: PendingApproval[];
  index: number;
  onIndex: (index: number) => void;
  runs: RunSummary[];
  notionParent: string | null;
  /** Saves "Don't ask again" before the request is allowed. */
  onRemember: (rule: Remember) => Promise<void>;
};

/** One waiting request in plain words, with Deny and Allow, and the others a click away. */
export function ApprovalCard({ approvals, index, onIndex, runs, notionParent, onRemember }: ApprovalProps) {
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = Math.min(index, approvals.length - 1);
  const request = approvals[at];
  const run = runs.find((r) => r.id === request.runId);
  const words = requestWords(request);
  const rule = rememberRule(request);
  // A new page goes under the default location unless the goal said otherwise.
  const where = request.label.startsWith("Notion · create") && notionParent ? ` → ${notionParent}` : "";

  async function answer(allow: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (allow && remember && rule) await onRemember(rule);
      await invoke("answer_approval", { runId: request.runId, requestId: request.requestId, allow });
      setRemember(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card needs" aria-label="Permission request">
      <header className="card-head">
        <Face state="needs" />
        <span className="card-tag needs">{run ? agentName(run) : "An agent"} asks</span>
        {approvals.length > 1 && (
          <>
            <span className="card-meta mono">
              {at + 1} of {approvals.length}
            </span>
            <button className="icon-btn" aria-label="Next request" onClick={() => onIndex((at + 1) % approvals.length)}>
              <Icon name="chevron" size={12} />
            </button>
          </>
        )}
      </header>
      <div className="card-body">
        <strong className="card-title">{words.title}</strong>
        <span className={`card-detail one-line ${words.mono ? "mono" : ""}`} title={request.description ?? request.detail}>
          {words.detail || request.label}
          {where}
        </span>
      </div>
      {error && (
        <p className="card-error" role="alert">
          {error}
        </p>
      )}
      <div className="card-actions">
        <button className="btn" disabled={busy} onClick={() => answer(false)}>
          Deny
        </button>
        <button className="btn allow" disabled={busy} onClick={() => answer(true)}>
          Allow
        </button>
      </div>
      {rule && (
        <label className="card-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {rule.label}
        </label>
      )}
    </section>
  );
}

type ResultProps = {
  card: AgentCard;
  notionParent: string | null;
  /** Files the assistant suggested removing, described, for the Recycle button. */
  suggested: ContextItem[];
  onDismiss: () => void;
  onReview: () => void;
  onRecycle: () => void;
};

/** A finished or failed agent: one line of result, the counts we have, and where to look next. */
export function ResultCard({ card, notionParent, suggested, onDismiss, onReview, onRecycle }: ResultProps) {
  const run = card.run;
  const failed = run?.status === "failed";

  if (failed && run) {
    return (
      <section className="card failed" aria-label={`${card.name} didn't finish`}>
        <header className="card-head">
          <Face state="failed" />
          <span className="card-tag failed">Didn't finish</span>
          <span className="card-meta">{card.place}</span>
        </header>
        <div className="card-body">
          <strong className="card-title one-line" title={run.goal}>
            {run.goal}
          </strong>
          <span className="card-detail">{failReason(run)}</span>
        </div>
        <div className="card-actions">
          <button className="btn" onClick={onDismiss}>
            Dismiss
          </button>
          <button className="btn" onClick={() => revealItemInDir(run.logPath)}>
            Show log
          </button>
          <button className="btn primary" onClick={onReview}>
            Review
          </button>
        </div>
      </section>
    );
  }

  const answer = run ? run.result : card.session?.lastMessage ?? null;
  const text = recycleSuggestions(answer).text;
  const link = run ? firstLink(text) : null;
  const made = link ? resultHeadline(link, notionParent) : null;
  const summary = resultSummary(text);
  const title = made?.title ?? summary.title;
  const detail = made?.note ?? summary.summary;
  const counts = run ? ruleCounts(run) : [];
  const when = run?.endedAt ? `Done · ${took(run.startedAt, run.endedAt)}` : "Done";

  return (
    <section className="card done" aria-label={`${card.name} is done`}>
      <header className="card-head">
        <Face state="done" />
        <span className="card-tag done">{when}</span>
        <span className="card-meta one-line">{card.place}</span>
      </header>
      <div className="card-body">
        <strong className="card-title one-line" title={firstLine(answer) ?? title}>
          {title}
        </strong>
        {detail && <span className="card-detail two-line">{detail}</span>}
      </div>
      {counts.length > 0 && (
        <div className="card-counts">
          {counts.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}
      <div className="card-actions">
        <button className="btn" onClick={onDismiss}>
          Dismiss
        </button>
        <button className={`btn ${link || suggested.length > 0 ? "" : "primary"}`} onClick={onReview}>
          Review
        </button>
        {suggested.length > 0 ? (
          <button className="btn primary" onClick={onRecycle}>
            Recycle {suggested.length}
          </button>
        ) : (
          link && (
            <button className="btn primary" onClick={() => openUrl(link)}>
              {linkLabel(link)}
            </button>
          )
        )}
      </div>
    </section>
  );
}

/** While files are dragged over the island: what they are, and that nothing leaves the computer. */
export function DropCard({ items }: { items: ContextItem[] }) {
  return (
    <section className="card drop" aria-live="polite">
      <header className="card-head">
        <Face state="thinking" />
        <span className="card-tag working">Drop to add as context</span>
      </header>
      <div className="card-body">
        <strong className="card-title">{items.length > 0 ? contextCounts(items).join(" · ") : "Files, folders or screenshots"}</strong>
        <span className="card-detail">Stays on this computer. Agents read only what you hand over.</span>
      </div>
    </section>
  );
}
