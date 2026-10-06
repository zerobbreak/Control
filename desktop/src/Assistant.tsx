// The assistant's small cards on the island: asking once for a capability, moving suggested
// files to the Recycle Bin, and what is playing.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CAPABILITIES, humanBytes, recycleLabel, sizeFromDetail } from "./capabilities";
import { Face } from "./Face";
import { Icon } from "./Icon";
import type { Capability, ContextItem, MediaAction, NowPlaying, RunSummary } from "./types";

/**
 * Asks once before Mission Control uses a capability on this computer. The answer is saved and
 * can be changed on the Desk's Boundaries screen; the full lists are in the detail's tooltip.
 */
export function CapabilityCard({ capability, onAnswer }: { capability: Capability; onAnswer: (allowed: boolean) => void }) {
  const copy = CAPABILITIES[capability];
  const never = copy.never[0];
  const tooltip = [...copy.does, ...copy.never.map((line) => `Never: ${line}`)].join("\n");
  return (
    <section className="card needs" aria-label={`${copy.name}: permission`}>
      <header className="card-head">
        <Face state="needs" />
        <span className="card-tag needs">Mission Control asks · once</span>
      </header>
      <div className="card-body">
        <strong className="card-title">{copy.ask}</strong>
        <span className="card-detail" title={tooltip}>
          {copy.does[0]}. Never {never.charAt(0).toLowerCase() + never.slice(1)}.
        </span>
      </div>
      <div className="card-actions">
        <button className="btn" onClick={() => onAnswer(false)}>
          Don't allow
        </button>
        <button className="btn allow" onClick={() => onAnswer(true)}>
          Allow
        </button>
      </div>
    </section>
  );
}

/** A capability the user said no to, with where to change it. */
export function TurnedOff({ capability, onBoundaries }: { capability: Capability; onBoundaries: () => void }) {
  return (
    <p className="card-error">
      {CAPABILITIES[capability].name} is turned off.{" "}
      <button className="text-link" onClick={onBoundaries}>
        Change in Boundaries
      </button>
    </p>
  );
}

/** What each suggested path is, with its size, for the Recycle button's label. */
export function useDescribed(paths: string[]): ContextItem[] {
  const [items, setItems] = useState<ContextItem[]>([]);
  const key = paths.join("\n");
  useEffect(() => {
    if (paths.length === 0) {
      setItems([]);
      return;
    }
    invoke<ContextItem[]>("describe_paths", { paths }).then(setItems, () => setItems([]));
  }, [key]);
  return items.filter((i) => i.kind !== "missing");
}

/** The total size of described files, or null when any size is unknown. */
export function totalBytes(items: ContextItem[]): number | null {
  const sizes = items.map((i) => sizeFromDetail(i.detail));
  return sizes.every((s) => s !== null) ? sizes.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
}

type RecycleProps = {
  run: RunSummary;
  items: ContextItem[];
  /** The user's answer for recycling, or null if not asked yet. */
  allowed: boolean | null;
  onCapability: (allowed: boolean) => void;
  onBoundaries: () => void;
  onClose: () => void;
};

type RecycleStage = "confirm" | "moving" | "done" | "error";

/**
 * Files the assistant suggested removing. Moving them needs recycling allowed once, and then each
 * batch confirmed; they go to the Recycle Bin, never deleted outright.
 */
export function RecycleCard({ run, items, allowed, onCapability, onBoundaries, onClose }: RecycleProps) {
  const [stage, setStage] = useState<RecycleStage>("confirm");
  const [message, setMessage] = useState("");
  const count = `${items.length} file${items.length === 1 ? "" : "s"}`;

  if (allowed === null) return <CapabilityCard capability="recycleFiles" onAnswer={onCapability} />;

  async function recycle() {
    setStage("moving");
    try {
      const moved = await invoke<number>("recycle_files", { runId: run.id, paths: items.map((i) => i.path) });
      setMessage(`Moved ${count} · ${humanBytes(moved)} to the Recycle Bin.`);
      setStage("done");
    } catch (err) {
      setMessage(String(err));
      setStage("error");
    }
  }

  const bytes = totalBytes(items);
  return (
    <section className="card" aria-label="Suggested to remove">
      <header className="card-head">
        <Face state={stage === "done" ? "done" : "idle"} />
        <span className="card-tag">Suggested to remove</span>
        {items.length > 0 && (
          <button className="icon-btn meta" aria-label="Show in Explorer" title="Show in Explorer" onClick={() => revealItemInDir(items[0].path)}>
            <Icon name="folder" size={13} />
          </button>
        )}
      </header>
      <div className="card-body">
        <strong className="card-title">
          {stage === "done" ? message : `Move ${count}${bytes !== null ? ` · ${humanBytes(bytes)}` : ""} to the Recycle Bin?`}
        </strong>
        {stage !== "done" && (
          <span className="card-detail one-line" title={items.map((i) => i.path).join("\n")}>
            {items.map((i) => i.name).join(", ")}
          </span>
        )}
      </div>
      {allowed === false ? (
        <TurnedOff capability="recycleFiles" onBoundaries={onBoundaries} />
      ) : stage === "error" ? (
        <p className="card-error">{message}</p>
      ) : stage !== "done" ? (
        <p className="card-note">You can restore them from the Recycle Bin.</p>
      ) : null}
      <div className="card-actions">
        {stage === "done" ? (
          <button className="btn" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            {allowed && (
              <button className="btn primary" onClick={recycle} disabled={stage === "moving"}>
                {stage === "moving" ? "Moving…" : recycleLabel(items.length, bytes).replace("Recycle", "Move")}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** The collapsed island's line for what is playing: a small level meter, the title and the app. */
export function NowPlayingLine({ media }: { media: NowPlaying }) {
  return (
    <span className={`now-playing ${media.playing ? "playing" : ""}`} title={`${media.title}${media.artist ? ` · ${media.artist}` : ""} · ${media.app}`}>
      <span className="bars" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="island-text">{media.title}</span>
      <span className="island-muted">· {media.app}</span>
    </span>
  );
}

/** Play / pause, skip and volume, revealed when the island is hovered or focused. */
export function MediaControls({ media, onControl }: { media: NowPlaying; onControl: (action: MediaAction) => void }) {
  return (
    <span className="media-controls">
      <button className="round" aria-label={media.playing ? "Pause" : "Play"} onClick={() => onControl("playPause")}>
        <Icon name={media.playing ? "pause" : "play"} size={13} />
      </button>
      <button className="round" aria-label="Next" onClick={() => onControl("next")}>
        <Icon name="next" size={13} />
      </button>
      <button className="round" aria-label="Volume down" onClick={() => onControl("volumeDown")}>
        <Icon name="volumeDown" size={13} />
      </button>
      <button className="round" aria-label="Volume up" onClick={() => onControl("volumeUp")}>
        <Icon name="volumeUp" size={13} />
      </button>
    </span>
  );
}
