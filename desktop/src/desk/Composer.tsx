// The goal box on Today: a goal, any folders and files handed over, then the plan for review
// before anything starts.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as pickPaths } from "@tauri-apps/plugin-dialog";
import { CAPABILITIES } from "../capabilities";
import { accessBadge, splitContext } from "../context";
import { RoleGlyph } from "../Face";
import { Icon } from "../Icon";
import { fileName } from "../runs";
import type { Capability, ContextItem, Preview, RunSummary, Settings } from "../types";
import { saveSettings } from "./actions";
import { tierLabel } from "./desk";

type Props = {
  settings: Settings | null;
  /** Paths dropped on the window, handed over with the next goal. `key` changes with each drop. */
  dropped: { key: number; paths: string[] } | null;
  dragging: boolean;
  /** Called once a drop has been taken, so it is not handed over again next time Today opens. */
  onDropTaken: () => void;
  onStarted: (run: RunSummary) => void;
};

const AGENT = {
  code: { role: "code", name: "Coding agent" },
  question: { role: "code", name: "Coding agent" },
  browse: { role: "web", name: "Browser agent" },
  assistant: { role: "assist", name: "Assistant" },
} as const;

export function Composer({ settings, dropped, dragging, onDropTaken, onStarted }: Props) {
  const [prompt, setPrompt] = useState("");
  const [items, setItems] = useState<ContextItem[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"planning" | "starting" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { folder, attachments } = splitContext(items);

  async function attach(paths: string[]) {
    try {
      const described = await invoke<ContextItem[]>("describe_paths", { paths });
      setItems((current) => [...current, ...described.filter((i) => !current.some((c) => c.path === i.path))]);
      setPreview(null);
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    if (!dropped) return;
    attach(dropped.paths);
    onDropTaken();
  }, [dropped?.key]);

  async function addFolder() {
    const picked = await pickPaths({ directory: true, multiple: true, title: "Add a folder" });
    if (picked) attach(Array.isArray(picked) ? picked : [picked]);
  }

  async function plan() {
    if (!prompt.trim() || busy) return;
    setBusy("planning");
    setError(null);
    try {
      setPreview(await invoke<Preview>("preview_task", { prompt, folder, attachments }));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    if (busy) return;
    setBusy("starting");
    setError(null);
    try {
      const run = await invoke<RunSummary>("start_task", { prompt, folder, attachments });
      setPrompt("");
      setItems([]);
      setPreview(null);
      onStarted(run);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  /** Saves the answer for a capability the plan needs, then plans again, since a preview carries the answer it was made with. */
  async function answerCapability(capability: Capability, allowed: boolean) {
    if (!settings) return;
    try {
      await saveSettings({ ...settings, capabilities: { ...settings.capabilities, [capability]: allowed } });
      setPreview(await invoke<Preview>("preview_task", { prompt, folder, attachments }));
    } catch (err) {
      setError(String(err));
    }
  }

  const blocked = preview?.capability != null && preview.capabilityGranted !== true;

  return (
    <div className="composer-wrap">
      <form
        className={`composer${dragging ? " dropping" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          plan();
        }}
      >
        <label htmlFor="desk-goal" className="visually-hidden">
          Give Mission Control a goal
        </label>
        <input
          id="desk-goal"
          value={prompt}
          placeholder={dragging ? "Drop to hand these over with the goal" : "Give it a goal, or drop files and folders here"}
          autoComplete="off"
          onChange={(e) => {
            setPrompt(e.target.value);
            setPreview(null);
          }}
        />
        <button type="button" className="composer-folder" onClick={addFolder}>
          Add folder
        </button>
        <button type="submit" className="composer-go" disabled={!prompt.trim() || busy !== null}>
          {busy === "planning" ? "Planning…" : "Plan it"}
        </button>
      </form>

      {items.length > 0 && (
        <ul className="composer-items" aria-label="Handed over with the goal">
          {items.map((item) => (
            <li key={item.path} className={item.kind === "missing" ? "missing" : ""} title={item.path}>
              <Icon name={item.kind === "folder" ? "folder" : item.kind === "image" ? "image" : item.kind === "pdf" ? "pdf" : "file"} size={14} />
              <span className="composer-item-name">{item.name}</span>
              {item.detail && <span className="composer-item-detail">{item.detail}</span>}
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => {
                  setItems((current) => current.filter((c) => c.path !== item.path));
                  setPreview(null);
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <section className="plan" aria-label="Plan">
          <div className="plan-head">
            <span className={`tile role-${AGENT[preview.decision.task].role}`}>
              <RoleGlyph role={AGENT[preview.decision.task].role} color="currentColor" size={13} />
            </span>
            <div className="plan-title">
              <span className="plan-agent">
                {AGENT[preview.decision.task].name}
                {preview.decision.task !== "assistant" && preview.decision.task !== "browse" && ` in ${fileName(preview.workdir)}`}
              </span>
              <span className="plan-reason">{preview.decision.reason}</span>
            </div>
          </div>
          <div className="chips">
            <span className="chip">
              {tierLabel(preview.decision.tier)} · {preview.model}
            </span>
            <span className="chip">{accessBadge(preview).label}</span>
            {preview.decision.task !== "assistant" && preview.decision.task !== "browse" && <span className="chip mc-mono">{preview.workdir}</span>}
          </div>

          {preview.capability && preview.capabilityGranted === null && (
            <div className="plan-ask">
              <span>{CAPABILITIES[preview.capability].ask}</span>
              <div className="row-actions">
                <button className="btn" onClick={() => answerCapability(preview.capability!, false)}>
                  Not now
                </button>
                <button className="btn primary" onClick={() => answerCapability(preview.capability!, true)}>
                  Allow
                </button>
              </div>
            </div>
          )}
          {preview.capability && preview.capabilityGranted === false && (
            <p className="plan-note">{CAPABILITIES[preview.capability].name} is turned off in Boundaries, so this can't start.</p>
          )}

          <div className="row-actions">
            <button className="btn" onClick={() => setPreview(null)}>
              Change it
            </button>
            <button className="btn primary" onClick={start} disabled={blocked || busy !== null}>
              {busy === "starting" ? "Starting…" : "Start"}
            </button>
          </div>
        </section>
      )}

      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
