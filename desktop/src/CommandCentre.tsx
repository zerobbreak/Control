import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { GitRule, Settings, Tier } from "./types";

const TIERS: { tier: Tier; label: string; model: string }[] = [
  { tier: "fast", label: "Fast", model: "Haiku" },
  { tier: "balanced", label: "Balanced", model: "Sonnet" },
  { tier: "strongest", label: "Strongest", model: "Opus" },
];

const GIT_RULES: { rule: GitRule; label: string }[] = [
  { rule: "ask", label: "Ask" },
  { rule: "allow", label: "Allow" },
  { rule: "never", label: "Never" },
];

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/**
 * What Mission Control and its agents are allowed to do. Every switch here is enforced by the
 * Rust runtime; defaults are the cautious choice and riskier features are opt-in.
 */
export default function CommandCentre() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  useEffect(() => {
    invoke<Settings>("get_settings").then(setSettings);
    const unlisten = listen<Settings>("settings-updated", (e) => setSettings(e.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  if (!settings) return <div className="command-centre" />;

  async function update(patch: Partial<Settings>) {
    const next = { ...settings!, ...patch };
    setSettings(next);
    setSave({ kind: "saving" });
    try {
      setSettings(await invoke<Settings>("update_settings", { settings: next }));
      setSave({ kind: "saved" });
    } catch (err) {
      setSave({ kind: "error", message: String(err) });
    }
  }

  return (
    <div className="command-centre">
      <header className="cc-head">
        <div>
          <h2>Command Centre</h2>
          <p>Choose what Mission Control and its agents may do. Changes apply to the next run or request.</p>
        </div>
        <SaveStatus state={save} />
      </header>

      <Section title="Agents">
        <Toggle
          label="Claude Code"
          description="Let Mission Control start Claude Code on code and questions about your folders."
          checked={settings.claudeEnabled}
          onChange={(claudeEnabled) => update({ claudeEnabled })}
        />
        <Toggle
          label="Assistant"
          description="Errands in your apps and files you drop on the pill, such as turning an assignment into a Notion page. It reads files and uses your claude.ai connectors, but never runs commands or changes files."
          checked={settings.assistantEnabled}
          onChange={(assistantEnabled) => update({ assistantEnabled })}
        />
        <Toggle
          label="Watch my other sessions"
          description="Read transcripts of Claude Code and Gemini CLI sessions you start yourself, so they show on the board. Off, Mission Control reads only its own runs."
          checked={settings.watchOtherSessions}
          onChange={(watchOtherSessions) => update({ watchOtherSessions })}
        />
      </Section>

      <Section title="Assistant">
        <Row
          label="Where new Notion pages go"
          description="A page name or link, used when a goal doesn't say. Leave empty and new pages start as private drafts."
        >
          <TextSetting
            value={settings.notionParent}
            placeholder="Uni Notes"
            label="Where new Notion pages go"
            onCommit={(notionParent) => update({ notionParent })}
          />
        </Row>
      </Section>

      <Section title="Models and spending">
        <Row
          label="Strongest model allowed"
          description="The router picks a model per goal. It never goes above this."
        >
          <div className="segmented" role="radiogroup" aria-label="Strongest model allowed">
            {TIERS.map(({ tier, label, model }) => (
              <button
                key={tier}
                role="radio"
                aria-checked={settings.maxTier === tier}
                className={settings.maxTier === tier ? "on" : ""}
                onClick={() => update({ maxTier: tier })}
              >
                {label}
                <span>{model}</span>
              </button>
            ))}
          </div>
        </Row>
        <Row label="Spending limit per run" description="A run stops once it has spent this much. Leave empty for no limit.">
          <BudgetInput value={settings.maxBudgetUsd} onCommit={(maxBudgetUsd) => update({ maxBudgetUsd })} />
        </Row>
      </Section>

      <Section title="Approvals">
        <Toggle
          label="Ask before file edits"
          description="Off, code runs edit files in their folder freely and ask only for commands. On, every edit waits for you."
          checked={settings.askBeforeEdits}
          onChange={(askBeforeEdits) => update({ askBeforeEdits })}
        />
        <ListEditor
          label="Always allow these commands"
          description="Matched as a whole command or its start, so “npm test” also allows “npm test -- --watch”. Commands chained with && ; | or redirects always ask."
          placeholder="npm test"
          items={settings.autoApprove}
          onChange={(autoApprove) => update({ autoApprove })}
          mono
        />
        <Toggle
          label="Read-only mode"
          description="Every run may read but never change anything, whatever the goal. Requests to edit or run commands are refused without asking."
          checked={settings.readOnlyMode}
          onChange={(readOnlyMode) => update({ readOnlyMode })}
        />
      </Section>

      <Section title="Folders">
        <ListEditor
          label="Only run in these folders"
          description="Empty means runs may start in any folder. Mission Control's scratch folder is always allowed."
          placeholder="C:\dev"
          items={settings.allowedFolders}
          onChange={(allowedFolders) => update({ allowedFolders })}
          mono
        />
      </Section>

      <Section title="Git and GitHub">
        <Row
          label="Agents committing"
          description="Ask follows your other approval settings. Never refuses, even with full autonomy on. Your own commits from the Changes tab are not affected."
        >
          <GitRuleControl label="Agents committing" value={settings.agentCommit} onChange={(agentCommit) => update({ agentCommit })} />
        </Row>
        <Row
          label="Agents pushing and opening pull requests"
          description="Covers git push and creating or merging pull requests with gh. Work leaves your computer, so think before choosing Allow."
        >
          <GitRuleControl label="Agents pushing" value={settings.agentPush} onChange={(agentPush) => update({ agentPush })} />
        </Row>
        <ListEditor
          label="Protected branches"
          description="Agents' commits and pushes on these branches always wait for you, whatever the rules above or full autonomy say."
          placeholder="main"
          items={settings.protectedBranches}
          onChange={(protectedBranches) => update({ protectedBranches })}
          mono
        />
      </Section>

      <Section title="Power features" danger>
        <DangerToggle
          label="Full autonomy"
          description="Allow every request without asking: commands, installs, deletions. Read-only runs and read-only mode still refuse changes. Only turn this on for work you would let run unattended."
          checked={settings.fullAutonomy}
          onChange={(fullAutonomy) => update({ fullAutonomy })}
        />
      </Section>
    </div>
  );
}

function Section({ title, danger, children }: { title: string; danger?: boolean; children: ReactNode }) {
  return (
    <section className={`cc-section ${danger ? "danger" : ""}`}>
      <h3>{title}</h3>
      <div className="cc-rows">{children}</div>
    </section>
  );
}

function Row({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return (
    <div className="cc-row">
      <div className="cc-text">
        <div className="cc-label">{label}</div>
        <p>{description}</p>
      </div>
      <div className="cc-control">{children}</div>
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function Toggle(props: { label: string; description: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <Row label={props.label} description={props.description}>
      <Switch label={props.label} checked={props.checked} onChange={props.onChange} />
    </Row>
  );
}

/** Turning a risky feature on takes a second, deliberate click; turning it off takes one. */
function DangerToggle(props: { label: string; description: string; checked: boolean; onChange: (on: boolean) => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Row label={props.label} description={props.description}>
      {confirming ? (
        <div className="confirm">
          <button className="ghost-button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button
            className="danger-button"
            onClick={() => {
              setConfirming(false);
              props.onChange(true);
            }}
          >
            Turn on
          </button>
        </div>
      ) : (
        <Switch label={props.label} checked={props.checked} onChange={(on) => (on ? setConfirming(true) : props.onChange(false))} />
      )}
    </Row>
  );
}

function GitRuleControl({ label, value, onChange }: { label: string; value: GitRule; onChange: (rule: GitRule) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {GIT_RULES.map(({ rule, label }) => (
        <button key={rule} role="radio" aria-checked={value === rule} className={value === rule ? "on" : ""} onClick={() => onChange(rule)}>
          {label}
        </button>
      ))}
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
      className="text-setting"
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
  const [text, setText] = useState(value?.toString() ?? "");
  useEffect(() => setText(value?.toString() ?? ""), [value]);

  function commit() {
    const usd = text.trim() === "" ? null : Number(text);
    if (usd !== null && !(usd > 0)) {
      setText(value?.toString() ?? "");
      return;
    }
    if (usd !== value) onCommit(usd);
  }

  return (
    <label className="budget">
      <span>$</span>
      <input
        inputMode="decimal"
        value={text}
        placeholder="No limit"
        aria-label="Spending limit per run in US dollars"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </label>
  );
}

function ListEditor(props: {
  label: string;
  description: string;
  placeholder: string;
  items: string[];
  onChange: (items: string[]) => void;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const item = draft.trim();
    if (!item) return;
    if (!props.items.includes(item)) props.onChange([...props.items, item]);
    setDraft("");
  }

  return (
    <div className="cc-row list">
      <div className="cc-text">
        <div className="cc-label">{props.label}</div>
        <p>{props.description}</p>
      </div>
      <ul className="chips">
        {props.items.map((item) => (
          <li key={item} className={props.mono ? "mono" : ""}>
            {item}
            <button aria-label={`Remove ${item}`} onClick={() => props.onChange(props.items.filter((i) => i !== item))}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          className={props.mono ? "mono" : ""}
          value={draft}
          placeholder={props.placeholder}
          aria-label={props.label}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  switch (state.kind) {
    case "idle":
      return null;
    case "saving":
      return <span className="save">Saving…</span>;
    case "saved":
      return <span className="save ok">Saved</span>;
    case "error":
      return <span className="save error">Not saved: {state.message}</span>;
  }
}
