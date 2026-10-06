import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useBackend } from "./backend";
import { CAPABILITIES } from "./capabilities";
import { RoleGlyph } from "./Face";
import { addItem, appAccessOf, autonomyOf, autonomyPatch, type Autonomy } from "./settings/autonomy";
import type { App, AppAccess, Capability, GitRule, Settings, Tier } from "./types";
import "./boundaries.css";

const CONNECTORS_URL = "https://claude.ai/settings/connectors";

const TIERS: { value: Tier; label: string; title: string }[] = [
  { value: "fast", label: "Fast", title: "Haiku" },
  { value: "balanced", label: "Balanced", title: "Sonnet" },
  { value: "strongest", label: "Strongest", title: "Opus" },
];

const GIT_RULES: { value: GitRule; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "allow", label: "Allow" },
  { value: "never", label: "Never" },
];

const APP_LEVELS: { value: AppAccess; label: string; title: string }[] = [
  { value: "read", label: "Read", title: "Look only: every change is refused" },
  { value: "ask", label: "Ask", title: "You approve each change" },
  { value: "act", label: "Act", title: "Changes go ahead on their own" },
];

const ALLOWED: { value: "on" | "off"; label: string }[] = [
  { value: "on", label: "Allowed" },
  { value: "off", label: "Off" },
];

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/**
 * Boundaries: what agents may do without asking. Every rule here is enforced by the Rust runtime,
 * whatever an agent is told; defaults are the cautious choice and riskier features are opt-in.
 */
export default function CommandCentre({ onViewAllSessions }: { onViewAllSessions: () => void }) {
  const live = useBackend<Settings | null>("get_settings", "settings-updated", null);
  // What the user just chose, shown until the runtime confirms it, so controls answer instantly.
  const [draft, setDraft] = useState<Settings | null>(null);
  const pending = useRef(0);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const settings = draft ?? live;

  useEffect(() => {
    if (save.kind !== "saved") return;
    const timer = window.setTimeout(() => setSave({ kind: "idle" }), 2500);
    return () => window.clearTimeout(timer);
  }, [save]);

  if (!settings) return <div className="bd" />;

  async function update(patch: Partial<Settings>) {
    const next = { ...settings!, ...patch };
    setDraft(next);
    pending.current++;
    setSave({ kind: "saving" });
    try {
      await invoke<Settings>("update_settings", { settings: next });
      setSave({ kind: "saved" });
    } catch (err) {
      setSave({ kind: "error", message: String(err) });
    } finally {
      // The runtime's settings-updated event carries what was saved; on failure this falls back to it.
      if (--pending.current === 0) setDraft(null);
    }
  }

  return (
    <div className="bd">
      <header className="bd-head">
        <div className="bd-intro">
          <h1>Boundaries</h1>
          <p>What your agents may do without asking. The runtime enforces every rule here, whatever an agent is told.</p>
        </div>
        <SaveStatus state={save} />
      </header>

      <AutonomySection settings={settings} update={update} />
      <AppsSection settings={settings} update={update} />

      <Section id="computer" title="This computer">
        {(Object.keys(CAPABILITIES) as Capability[]).map((capability) => {
          const copy = CAPABILITIES[capability];
          const answer = settings.capabilities[capability];
          return (
            <Row key={capability} label={copy.name} description={`${copy.does[0]}. Never ${lowerFirst(copy.never[0])}.`}>
              {answer === undefined && <span className="bd-unasked">Not asked yet</span>}
              <Segmented
                label={copy.name}
                options={ALLOWED}
                value={answer === undefined ? undefined : answer ? "on" : "off"}
                onChange={(v) => update({ capabilities: { ...settings.capabilities, [capability]: v === "on" } })}
              />
            </Row>
          );
        })}
        <Row label="Watch my other agent sessions" description="Show Claude Code and Gemini CLI sessions you started yourself, read only.">
          <button className="bd-link" onClick={onViewAllSessions}>
            View all sessions
          </button>
          <Switch label="Watch my other agent sessions" checked={settings.watchOtherSessions} onChange={(watchOtherSessions) => update({ watchOtherSessions })} />
        </Row>
      </Section>

      <Section id="code" title="Code and git">
        <Row label="Agents committing" description="Never refuses, even with full autonomy. Your own commits from Changes are not affected.">
          <Segmented label="Agents committing" options={GIT_RULES} value={settings.agentCommit} onChange={(agentCommit) => update({ agentCommit })} />
        </Row>
        <Row label="Agents pushing" description="Covers git push and opening or merging pull requests. Work leaves your computer.">
          <Segmented label="Agents pushing" options={GIT_RULES} value={settings.agentPush} onChange={(agentPush) => update({ agentPush })} />
        </Row>
        <ListRow
          label="Protected branches"
          description="Agents always ask before committing or pushing here, even with full autonomy."
          items={settings.protectedBranches}
          placeholder="main"
          onChange={(protectedBranches) => update({ protectedBranches })}
        />
      </Section>

      <Section id="models" title="Agents, models and spend">
        <Row
          label={
            <>
              <span className="bd-glyph">
                <RoleGlyph role="code" size={12} />
              </span>
              Coding agent <span className="bd-sub">Claude Code</span>
            </>
          }
          description="Code and questions about your folders."
        >
          <Switch label="Coding agent" checked={settings.claudeEnabled} onChange={(claudeEnabled) => update({ claudeEnabled })} />
        </Row>
        <Row
          label={
            <>
              <span className="bd-glyph">
                <RoleGlyph role="assist" color="var(--needs)" size={13} />
              </span>
              Assistant <span className="bd-sub">Files and your apps</span>
            </>
          }
          description="Errands in your apps and the files you hand over. Never runs commands or changes code."
        >
          <Switch label="Assistant" checked={settings.assistantEnabled} onChange={(assistantEnabled) => update({ assistantEnabled })} />
        </Row>
        <Row label="Strongest model allowed" description="The router picks a model per goal and never goes above this. Simple goals still get a fast model.">
          <Segmented label="Strongest model allowed" options={TIERS} value={settings.maxTier} onChange={(maxTier) => update({ maxTier })} />
        </Row>
        <Row label={<label htmlFor="bd-budget">Spending limit per run</label>} description="A run stops when it reaches this. Leave empty for no limit.">
          <BudgetInput value={settings.maxBudgetUsd} onCommit={(maxBudgetUsd) => update({ maxBudgetUsd })} />
        </Row>
      </Section>
    </div>
  );
}

type Update = (patch: Partial<Settings>) => void;

function AutonomySection({ settings, update }: { settings: Settings; update: Update }) {
  const level = autonomyOf(settings);
  const [confirming, setConfirming] = useState(false);

  const cards: { value: Autonomy; title: string; text: string }[] = [
    { value: "look", title: "Look only", text: "Agents read and answer. Every change is refused." },
    {
      value: "ask",
      title: "Ask me",
      text: settings.askBeforeEdits ? "Every edit, command and app change waits for you." : "Edits go ahead; commands and app changes wait for you.",
    },
    { value: "full", title: "Full autonomy", text: "Nothing asks. Git rules and protected branches still hold." },
  ];

  function choose(next: Autonomy) {
    // Full autonomy lets agents install, delete and run anything unattended, so it takes a second click.
    if (next === "full" && level !== "full") {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    if (next !== level) update(autonomyPatch(next));
  }

  return (
    <Section
      id="autonomy"
      title="Autonomy"
      before={
        <>
          <div className="bd-levels" role="group" aria-label="Autonomy">
            {cards.map((card) => (
              <button
                key={card.value}
                className={`bd-level ${card.value}`}
                aria-pressed={level === card.value}
                aria-expanded={card.value === "full" ? confirming : undefined}
                onClick={() => choose(card.value)}
              >
                <span className="bd-level-title">{card.title}</span>
                <span className="bd-level-text">{card.text}</span>
              </button>
            ))}
          </div>
          {confirming && (
            <div className="bd-confirm" role="alertdialog" aria-labelledby="bd-confirm-title" aria-describedby="bd-confirm-text">
              <div>
                <strong id="bd-confirm-title">Turn on full autonomy?</strong>
                <p id="bd-confirm-text">
                  Agents will run commands, install software and delete files without asking. Git rules, protected branches and apps set to Read still hold. Only
                  choose this for work you would let run unattended.
                </p>
              </div>
              <div className="bd-confirm-actions">
                <button className="bd-btn" autoFocus onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button
                  className="bd-btn danger"
                  onClick={() => {
                    setConfirming(false);
                    update(autonomyPatch("full"));
                  }}
                >
                  Turn on
                </button>
              </div>
            </div>
          )}
        </>
      }
    >
      <Row label="Ask before editing files too" description="Every file change in a project waits for you.">
        <Switch label="Ask before editing files" checked={settings.askBeforeEdits} onChange={(askBeforeEdits) => update({ askBeforeEdits })} />
      </Row>
      <ListRow
        label="Commands that never ask"
        description="Matched as a whole command or its start, so “npm test” also allows “npm test -- --watch”. Chained commands always ask."
        items={settings.autoApprove}
        placeholder="npm test"
        onChange={(autoApprove) => update({ autoApprove })}
      />
      <ListRow
        label="Folders agents may work in"
        description="Empty means any folder. Mission Control's scratch folder is always allowed."
        items={settings.allowedFolders}
        addLabel="Add folder"
        onAdd={async () => {
          const picked = await pickFolder({ directory: true, multiple: false, title: "Let agents work in a folder" });
          if (typeof picked === "string") update({ allowedFolders: addItem(settings.allowedFolders, picked) });
        }}
        onChange={(allowedFolders) => update({ allowedFolders })}
      />
    </Section>
  );
}

function AppsSection({ settings, update }: { settings: Settings; update: Update }) {
  const [apps, setApps] = useState<App[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Claude Code takes a few seconds to say which apps are connected.
  async function load() {
    setLoading(true);
    setProblem(null);
    try {
      setApps(await invoke<App[]>("list_apps"));
    } catch (err) {
      setProblem(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Notion's default parent sits in its row when it's connected, and in a row of its own otherwise.
  const notionRow = apps?.some((app) => isNotion(app) && app.status === "connected") ?? false;
  const notionParent = (
    <TextSetting
      value={settings.notionParent}
      placeholder="a private draft"
      label="Where new Notion pages go"
      onCommit={(notionParent) => update({ notionParent })}
    />
  );

  return (
    <Section
      id="apps"
      title="Apps"
      action={
        <button className="bd-link" onClick={load} disabled={loading}>
          {loading ? "Checking…" : "Check again"}
        </button>
      }
      hint="Read: look only. Ask: you approve each change. Act: changes go ahead on their own."
    >
      {apps === null && loading && <p className="bd-row bd-note">Checking which apps are connected…</p>}
      {problem && (
        <p className="bd-row bd-note error" role="alert">
          {problem}
        </p>
      )}
      {apps?.length === 0 && <p className="bd-row bd-note">No apps are connected to Claude yet.</p>}
      {apps?.map((app) => (
        <div className="bd-row" key={app.id}>
          <span className="bd-app-mark" aria-hidden="true">
            {app.name.charAt(0).toUpperCase()}
          </span>
          <div className="bd-text app">
            <span className="bd-label">{app.name}</span>
            {isNotion(app) && app.status === "connected" ? (
              <span className="bd-desc bd-inline">New pages go in {notionParent}</span>
            ) : (
              <AppStatusLine status={app.status} />
            )}
          </div>
          <div className="bd-control">
            {app.status === "needsAuth" ? (
              <button className="bd-btn needs" onClick={() => openUrl(CONNECTORS_URL)}>
                Connect
              </button>
            ) : (
              <Segmented
                label={`${app.name} access`}
                options={APP_LEVELS}
                value={appAccessOf(settings, app.id)}
                onChange={(level) => update({ appAccess: { ...settings.appAccess, [app.id]: level } })}
              />
            )}
          </div>
        </div>
      ))}
      {!notionRow && (
        <Row label="Where new Notion pages go" description="A page name or link, used when a goal doesn't say. Empty, new pages start as private drafts.">
          {notionParent}
        </Row>
      )}
      <Row label="Search and read in apps without asking" description="Creating, changing and sending still follow each app's level.">
        <Switch label="Search and read in apps without asking" checked={settings.readAppsFreely} onChange={(readAppsFreely) => update({ readAppsFreely })} />
      </Row>
    </Section>
  );
}

function AppStatusLine({ status }: { status: App["status"] }) {
  if (status === "needsAuth") return <span className="bd-desc needs">Needs you to sign in on claude.ai</span>;
  if (status === "failed") return <span className="bd-desc failed">Couldn't connect. Check again in a moment.</span>;
  return <span className="bd-desc">Connected</span>;
}

function isNotion(app: App) {
  return /notion/i.test(app.id) || app.name.toLowerCase() === "notion";
}

/** A labelled group of rows in one card; `before` (the autonomy levels) sits between label and card. */
function Section(props: { id: string; title: string; action?: ReactNode; hint?: string; before?: ReactNode; children: ReactNode }) {
  return (
    <section className="bd-section" id={`bd-${props.id}`} aria-labelledby={`bd-${props.id}-title`}>
      <div className="bd-section-head">
        <h2 className="mc-label" id={`bd-${props.id}-title`}>
          {props.title}
        </h2>
        {props.action}
      </div>
      {props.hint && <p className="bd-hint">{props.hint}</p>}
      {props.before}
      <div className="bd-card">{props.children}</div>
    </section>
  );
}

function Row({ label, description, children }: { label: ReactNode; description?: string; children: ReactNode }) {
  return (
    <div className="bd-row">
      <div className="bd-text">
        <span className="bd-label">{label}</span>
        {description && <span className="bd-desc">{description}</span>}
      </div>
      <div className="bd-control">{children}</div>
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className={`bd-switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function Segmented<T extends string>(props: {
  label: string;
  options: { value: T; label: string; title?: string }[];
  value: T | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <div className="bd-seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} aria-pressed={props.value === o.value} title={o.title} onClick={() => props.value !== o.value && props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Chips with a remove button each, and an Add that opens a field, or a picker when `onAdd` is given. */
function ListRow(props: {
  label: string;
  description: string;
  items: string[];
  placeholder?: string;
  addLabel?: string;
  onAdd?: () => void;
  onChange: (items: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);

  function finish(keep: boolean) {
    if (keep) props.onChange(addItem(props.items, draft));
    setDraft("");
    setAdding(false);
    addButton.current?.focus();
  }

  return (
    <div className="bd-row">
      <div className="bd-text wide">
        <span className="bd-label">{props.label}</span>
        <span className="bd-desc">{props.description}</span>
        <ul className="bd-chips" aria-label={props.label}>
          {props.items.map((item) => (
            <li key={item} className="bd-chip mc-mono" title={item}>
              <span>{item}</span>
              <button aria-label={`Remove ${item}`} onClick={() => props.onChange(props.items.filter((i) => i !== item))}>
                ×
              </button>
            </li>
          ))}
          <li>
            {adding ? (
              <input
                className="bd-chip-input mc-mono"
                autoFocus
                value={draft}
                placeholder={props.placeholder}
                aria-label={`Add to ${props.label.toLowerCase()}`}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => finish(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    finish(true);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    finish(false);
                  }
                }}
              />
            ) : (
              <button ref={addButton} className="bd-chip-add" onClick={() => (props.onAdd ? props.onAdd() : setAdding(true))}>
                {props.addLabel ?? "Add"}
              </button>
            )}
          </li>
        </ul>
      </div>
    </div>
  );
}

/** A free-text setting, saved when the field loses focus or Enter is pressed. */
function TextSetting(props: { value: string | null; placeholder: string; label: string; onCommit: (text: string | null) => void }) {
  const [text, setText] = useState(props.value ?? "");
  useEffect(() => setText(props.value ?? ""), [props.value]);

  function commit() {
    const next = text.trim() === "" ? null : text.trim();
    if (next !== props.value) props.onCommit(next);
  }

  return (
    <input
      className="bd-text-input"
      value={text}
      placeholder={props.placeholder}
      aria-label={props.label}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function BudgetInput({ value, onCommit }: { value: number | null; onCommit: (usd: number | null) => void }) {
  const [text, setText] = useState(value?.toFixed(2) ?? "");
  useEffect(() => setText(value?.toFixed(2) ?? ""), [value]);

  function commit() {
    const usd = text.trim() === "" ? null : Number(text);
    if (usd !== null && !(usd > 0)) {
      setText(value?.toFixed(2) ?? "");
      return;
    }
    if (usd !== value) onCommit(usd);
  }

  return (
    <span className="bd-budget">
      <span aria-hidden="true">$</span>
      <input
        id="bd-budget"
        inputMode="decimal"
        value={text}
        placeholder="No limit"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </span>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span className={`bd-save ${state.kind}`} role="status" aria-live="polite">
      {state.kind === "saving" && "Saving…"}
      {state.kind === "saved" && "Saved"}
      {state.kind === "error" && `Not saved: ${state.message}`}
    </span>
  );
}

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
