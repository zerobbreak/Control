// "Recycle N files · size" on a finished run that suggested files to remove. Recycling needs
// the capability allowed once, then each batch confirmed.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { humanBytes, recycleLabel, sizeFromDetail } from "../capabilities";
import { Icon } from "../Icon";
import type { ContextItem, RunSummary } from "../types";

type Stage = "idle" | "confirm" | "moving" | "done" | "error";

type Props = {
  run: RunSummary;
  paths: string[];
  /** The user's answer for recycling: allowed, not allowed, or null if not asked yet. */
  allowed: boolean | null;
  onAllow: (allowed: boolean) => void;
};

export function RecycleAction({ run, paths, allowed, onAllow }: Props) {
  const [items, setItems] = useState<ContextItem[] | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    invoke<ContextItem[]>("describe_paths", { paths }).then(setItems, () => setItems([]));
  }, [paths.join("\n")]);

  const present = (items ?? []).filter((i) => i.kind !== "missing");
  const sizes = present.map((i) => sizeFromDetail(i.detail));
  const bytes = sizes.every((s) => s !== null) ? sizes.reduce<number>((a, b) => a + (b ?? 0), 0) : null;

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

  // Already moved, or never found: nothing left to offer.
  if (items && present.length === 0 && stage !== "done") return null;
  if (!items) return null;

  if (stage === "done") return <span className="recycle-note done">{message}</span>;
  if (allowed === false) return <span className="recycle-note">Recycling is off in Boundaries</span>;

  if (stage === "confirm") {
    return (
      <div className="recycle-confirm">
        <span>
          {allowed === null
            ? "Let Mission Control move suggested files to the Recycle Bin?"
            : `Move ${present.length} file${present.length === 1 ? "" : "s"} to the Recycle Bin? You can restore them from there.`}
        </span>
        <div className="row-actions">
          <button className="btn" onClick={() => (allowed === null ? onAllow(false) : setStage("idle"))}>
            {allowed === null ? "Not now" : "Cancel"}
          </button>
          <button className="btn primary" onClick={() => (allowed === null ? onAllow(true) : recycle())}>
            {allowed === null ? "Allow" : "Move"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="recycle-action">
      <button className="btn soft" onClick={() => setStage("confirm")} disabled={stage === "moving"} title={present.map((i) => i.path).join("\n")}>
        <Icon name="recycle" size={14} />
        {stage === "moving" ? "Moving…" : recycleLabel(present.length, bytes)}
      </button>
      {stage === "error" && (
        <span className="recycle-note failed" role="alert">
          {message}
        </span>
      )}
    </div>
  );
}
