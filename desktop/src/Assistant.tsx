// The personal assistant's views: asking permission for a capability, the routing card for a
// quick browser action, files the assistant suggests removing, and what is playing.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { BlobAvatar } from "./avatar/BlobAvatar";
import { CAPABILITIES, humanBytes, recycleLabel, sizeFromDetail } from "./capabilities";
import { Icon } from "./Icon";
import { fileName } from "./runs";
import type { Capability, ContextItem, MediaAction, NowPlaying, Preview, RunSummary } from "./types";

/**
 * Asks once before Mission Control uses a capability on this computer. The answer is saved and
 * can be changed in the Command Centre.
 */
export function PermissionCard({ capability, onAnswer }: { capability: Capability; onAnswer: (allowed: boolean) => void }) {
  const copy = CAPABILITIES[capability];
  return (
    <section className="permission-card" aria-label={`${copy.name}: permission`}>
      <div className="permission-card-head">
        <Icon name="shield" size={15} />
        <strong>{copy.ask}</strong>
      </div>
      <div className="permission-lists">
        <ul>
          {copy.does.map((line) => (
            <li key={line}>
              <Icon name="check" size={12} className="yes" />
              {line}
            </li>
          ))}
        </ul>
        <ul>
          {copy.never.map((line) => (
            <li key={line}>
              <Icon name="x" size={12} className="no" />
              Never {line.charAt(0).toLowerCase() + line.slice(1)}
            </li>
          ))}
        </ul>
      </div>
      <p className="permission-foot">Asked once. Change it any time in the Command Centre.</p>
      <div className="answer">
        <button className="deny" onClick={() => onAnswer(false)}>
          Don't allow
        </button>
        <button className="allow" onClick={() => onAnswer(true)}>
          Allow
        </button>
      </div>
    </section>
  );
}

/** A capability the user said no to, with where to change it. */
function TurnedOff({ capability }: { capability: Capability }) {
  return (
    <p className="view-note error">
      {CAPABILITIES[capability].name} is turned off. Turn it on in the Command Centre to use it.
    </p>
  );
}

type RoutingProps = {
  goal: string;
  preview: Preview;
  starting: boolean;
  onCapability: (capability: Capability, allowed: boolean) => void;
  onCancel: () => void;
  onGo: () => void;
};

/**
 * A quick action routed to the browser agent: who will do it, with which model, why, and what it
 * may do. Nothing touches Chrome until Go, and Go waits for browser control to be allowed.
 */
export function RoutingCard({ goal, preview, starting, onCapability, onCancel, onGo }: RoutingProps) {
  const { capability, capabilityGranted } = preview;
  const ready = !capability || capabilityGranted === true;
  return (
    <div className="review-view routing-view">
      <div className="review-body">
        <p className="chat-bubble">{goal}</p>

        <section className="routing-card">
          <h3 className="section-label">Routing</h3>
          <div className="routing-who">
            <BlobAvatar role="web" state="thinking" size={34} />
            <Icon name="chevron" size={12} className="plan-arrow" />
            <span className="app-tile chrome">
              <Icon name="globe" size={15} />
            </span>
            <div className="routing-name">
              <strong>Browser agent in Chrome</strong>
              <span className="model-chip">{preview.model}</span>
            </div>
          </div>
          <p className="routing-reason">{preview.decision.reason}</p>
          <div className="routing-access">
            <span className="access-badge auto">Automatic in Chrome</span>
            <span>Opens tabs and plays; never signs in, buys or posts</span>
          </div>
        </section>

        {capability && capabilityGranted === null && <PermissionCard capability={capability} onAnswer={(allowed) => onCapability(capability, allowed)} />}
        {capability && capabilityGranted === false && <TurnedOff capability={capability} />}
      </div>

      <div className="review-actions">
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" onClick={onGo} disabled={!ready || starting}>
          {starting ? "Starting…" : "Go now"}
        </button>
      </div>
    </div>
  );
}

type RecycleProps = {
  run: RunSummary;
  paths: string[];
  allowed: boolean | null;
  onCapability: (allowed: boolean) => void;
};

type RecycleStage = "idle" | "confirm" | "moving" | "done" | "error";

/**
 * Files the assistant suggested removing, with their sizes. Moving them to the Recycle Bin needs
 * recycling allowed once, and then each batch confirmed.
 */
export function RecycleSuggestion({ run, paths, allowed, onCapability }: RecycleProps) {
  const [items, setItems] = useState<ContextItem[]>([]);
  const [stage, setStage] = useState<RecycleStage>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    invoke<ContextItem[]>("describe_paths", { paths }).then(setItems);
  }, [paths.join("\n")]);

  const present = items.filter((i) => i.kind !== "missing");
  const sizes = present.map((i) => sizeFromDetail(i.detail));
  const bytes = sizes.every((s) => s !== null) ? sizes.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  const folder = run.attachments.find((a) => paths.some((p) => p.startsWith(a)));

  async function recycle() {
    setStage("moving");
    try {
      const moved = await invoke<number>("recycle_files", { runId: run.id, paths: present.map((i) => i.path) });
      setMessage(`Moved ${present.length} file${present.length === 1 ? "" : "s"} · ${humanBytes(moved)} to the Recycle Bin.`);
      setStage("done");
    } catch (err) {
      setMessage(String(err));
      setStage("error");
    }
  }

  if (present.length === 0) return null;

  return (
    <section className="detail-section recycle">
      <h3>Suggested to remove</h3>
      <ul className="recycle-list">
        {present.map((item) => (
          <li key={item.path} title={item.path}>
            <span className={`context-icon ${item.kind}`}>
              <Icon name={item.kind === "image" ? "image" : "file"} size={15} />
            </span>
            <span className="recycle-name">{item.name}</span>
            <span className="recycle-size">{item.detail.split(" · ").pop()}</span>
          </li>
        ))}
      </ul>

      {stage === "done" ? (
        <p className="view-note done">{message}</p>
      ) : allowed === null && stage === "confirm" ? (
        <PermissionCard capability="recycleFiles" onAnswer={onCapability} />
      ) : allowed === false ? (
        <TurnedOff capability="recycleFiles" />
      ) : stage === "confirm" ? (
        <div className="recycle-confirm">
          <span>
            Move {present.length} file{present.length === 1 ? "" : "s"} to the Recycle Bin? You can restore them from there.
          </span>
          <div className="answer">
            <button className="deny" onClick={() => setStage("idle")}>
              Cancel
            </button>
            <button className="allow" onClick={recycle}>
              Move
            </button>
          </div>
        </div>
      ) : (
        <div className="recycle-actions">
          <button className="allow" onClick={() => setStage("confirm")} disabled={stage === "moving"}>
            <Icon name="recycle" size={14} />
            {stage === "moving" ? "Moving…" : recycleLabel(present.length, bytes)}
          </button>
          {folder && (
            <button className="secondary-button" onClick={() => revealItemInDir(present[0].path)}>
              Show in Explorer
            </button>
          )}
        </div>
      )}
      {stage === "error" && <p className="view-note error">{message}</p>}
    </section>
  );
}

/** What is playing, with play / pause, skip and volume. */
export function NowPlayingCard({ media, onControl }: { media: NowPlaying; onControl: (action: MediaAction) => void }) {
  return (
    <section className="now-playing" aria-label="Now playing">
      <div className="now-playing-head">
        <span className="now-playing-art">
          <Icon name="play" size={16} />
        </span>
        <div className="now-playing-text">
          <strong title={media.title}>{media.title}</strong>
          <span>
            {media.playing ? "Playing" : "Paused"} in {media.app}
            {media.artist ? ` · ${media.artist}` : ""}
          </span>
        </div>
      </div>
      <div className="now-playing-controls">
        <button className="round" aria-label="Volume down" onClick={() => onControl("volumeDown")}>
          <Icon name="volumeDown" size={15} />
        </button>
        <button className="round main" aria-label={media.playing ? "Pause" : "Play"} onClick={() => onControl("playPause")}>
          <Icon name={media.playing ? "pause" : "play"} size={17} />
        </button>
        <button className="round" aria-label="Next" onClick={() => onControl("next")}>
          <Icon name="next" size={15} />
        </button>
        <button className="round" aria-label="Volume up" onClick={() => onControl("volumeUp")}>
          <Icon name="volumeUp" size={15} />
        </button>
      </div>
    </section>
  );
}

/** The collapsed pill's line for what is playing: the title and a small level meter. */
export function NowPlayingFace({ media }: { media: NowPlaying }) {
  return (
    <span className={`now-playing-face ${media.playing ? "playing" : ""}`} title={`${media.title} · ${media.app}`}>
      <span className="now-playing-title">{media.title}</span>
      <span className="bars" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}

/** A loose folder's header line, as the design shows it: what it is and that it is only looked at. */
export function FolderChips({ item, model }: { item: ContextItem; model: string }) {
  return (
    <div className="folder-chips">
      <span className="chip">Not a project</span>
      <span className="chip read">Read only</span>
      <span className="model-chip">{model}</span>
      <span className="chip-note" title={item.path}>
        {fileName(item.path)} · {item.detail}
      </span>
    </div>
  );
}
