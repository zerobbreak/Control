// The collapsed island: two eyes, and only as much beside them as the moment needs.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Face, RoleGlyph, type FaceState } from "../Face";
import { MediaControls, NowPlayingLine } from "../Assistant";
import { recycleSuggestions } from "../capabilities";
import { firstLink, resultHeadline, type AgentCard } from "../runs";
import type { AgentEvent, MediaAction, NowPlaying, PendingApproval } from "../types";
import { currentAction, requestWords, resultSummary, type Moment } from "./island";

const FACE: Record<Moment, FaceState> = {
  rest: "idle",
  media: "idle",
  thinking: "thinking",
  working: "working",
  needs: "needs",
  done: "done",
  failed: "failed",
};

type Props = {
  moment: Moment;
  card: AgentCard | null;
  crew: AgentCard[];
  feed: AgentEvent[];
  /** The oldest request waiting on the lead agent, answerable from the island itself. */
  approval: PendingApproval | null;
  media: NowPlaying | null;
  notionParent: string | null;
  onOpen: () => void;
  onReview: () => void;
  onControl: (action: MediaAction) => void;
};

/** What the collapsed island says beside its face: a main part and a quieter one. */
function words(moment: Moment, card: AgentCard | null, feed: AgentEvent[], approval: PendingApproval | null, notionParent: string | null) {
  if (!card) return { main: "", muted: "" };
  switch (moment) {
    case "thinking":
    case "working": {
      const action = currentAction(card, feed, true);
      const doing = `${action.verb}${action.object ? ` ${action.object}` : ""}`;
      // While the assistant's apps connect, which apps is the news, not "your apps".
      const connecting = card.run?.status === "starting" && card.run.decision.task === "assistant";
      return card.place && !connecting ? { main: card.place, muted: doing } : { main: doing, muted: "" };
    }
    case "needs":
      return approval ? { main: requestWords(approval).short, muted: "" } : { main: `${card.name} is waiting in its terminal`, muted: "" };
    case "done": {
      const text = recycleSuggestions(card.run ? card.run.result : card.session?.lastMessage ?? null).text;
      const link = card.run ? firstLink(text) : null;
      const made = link ? resultHeadline(link, notionParent) : null;
      return { main: made?.title ?? resultSummary(text).title, muted: card.place };
    }
    case "failed":
      return { main: "Didn't finish", muted: card.place };
    default:
      return { main: "", muted: "" };
  }
}

/** The island at rest or at a glance; clicking its face opens the small card for the moment. */
export function Collapsed({ moment, card, crew, feed, approval, media, notionParent, onOpen, onReview, onControl }: Props) {
  const [busy, setBusy] = useState(false);
  const { main, muted } = words(moment, card, feed, approval, notionParent);

  async function answer(allow: boolean) {
    if (!approval) return;
    setBusy(true);
    try {
      await invoke("answer_approval", { runId: approval.runId, requestId: approval.requestId, allow });
    } finally {
      setBusy(false);
    }
  }

  const label = moment === "rest" ? "Mission Control" : `Mission Control: ${[main, muted].filter(Boolean).join(", ") || moment}`;
  return (
    <div className={`collapsed ${moment}`}>
      <button className="island-open" onClick={onOpen} aria-label={`${label}. Open`} title={[main, muted].filter(Boolean).join(" · ")}>
        <Face state={FACE[moment]} role={card?.role} />
        {moment === "media" && media && <NowPlayingLine media={media} />}
        {main && <span className="island-text">{main}</span>}
        {muted && <span className="island-muted">{muted}</span>}
        {crew.length > 0 && (
          <span className="crew" aria-hidden="true">
            {crew.map((c) => (
              <span key={c.key} className={`crew-dot ${c.state}`}>
                <RoleGlyph role={c.role} color={`var(--${c.state === "thinking" ? "text-2" : c.state === "needs" ? "needs" : c.state === "done" ? "done" : "working"})`} size={8} />
              </span>
            ))}
          </span>
        )}
      </button>
      {moment === "needs" && approval && (
        <>
          <button className="pill-btn" disabled={busy} onClick={() => answer(false)} aria-label={`Deny: ${main}`}>
            Deny
          </button>
          <button className="pill-btn allow" disabled={busy} onClick={() => answer(true)} aria-label={`Allow: ${main}`}>
            Allow
          </button>
        </>
      )}
      {moment === "done" && (
        <button className="pill-btn done" onClick={onReview}>
          Review
        </button>
      )}
      {moment === "media" && media && <MediaControls media={media} onControl={onControl} />}
    </div>
  );
}
