// Files as context and connected apps: composing a goal with what you handed over, reviewing
// what it will start, and choosing how much agents may do in each app.

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BlobAvatar } from "./avatar/BlobAvatar";
import { insertMention, mentionAt, mentionOptions, planSteps, type Mention } from "./context";
import { FolderChips } from "./Assistant";
import { Icon, type ICONS } from "./Icon";
import type { App, AppAccess, ContextItem, Preview } from "./types";

const KIND_ICON: Record<ContextItem["kind"], keyof typeof ICONS> = {
  folder: "folder",
  image: "image",
  pdf: "pdf",
  link: "link",
  file: "file",
  missing: "x",
};

/** Where to sign in to claude.ai connectors. Mission Control never handles those sign-ins itself. */
const CONNECTORS_URL = "https://claude.ai/settings/connectors";

type ComposerProps = {
  prompt: string;
  onPrompt: (text: string) => void;
  onSubmit: () => void;
  apps: App[];
  context: ContextItem[];
  busy: boolean;
  placeholder: string;
  /** Opens the + menu's file and folder pickers. */
  onBrowse: (directory: boolean) => void;
  /** A roomier box with a hint line, for composing a mission around context. */
  roomy?: boolean;
};

/**
 * The goal box. Typing `@` offers connected apps and handed-over files; picking one writes its
 * name into the goal, which is also how the router tells an errand in Notion from code work.
 */
export function Composer({ prompt, onPrompt, onSubmit, apps, context, busy, placeholder, onBrowse, roomy = false }: ComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [adding, setAdding] = useState(false);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const mention = mentionAt(prompt, caret);
  const options = mention && dismissed !== mention.start ? mentionOptions(mention.query, apps, context) : [];

  function choose(option: Mention) {
    const next = insertMention(prompt, caret, option.name);
    onPrompt(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (options.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((h) => (h + step + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(options[Math.min(highlight, options.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        setDismissed(mention!.start);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <form
      className={`composer ${roomy ? "roomy" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {options.length > 0 && (
        <div className="mention-menu" role="listbox" aria-label="Apps and files">
          {options.map((option, i) => (
            <button
              key={`${option.kind}:${option.name}`}
              type="button"
              role="option"
              aria-selected={i === highlight}
              className={i === highlight ? "active" : ""}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(option)}
            >
              {option.kind === "app" ? <AppMark name={option.name} size={22} /> : <span className="mention-file"><Icon name="file" size={12} /></span>}
              <strong>{option.name}</strong>
              <span>{option.detail}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={field}
        autoFocus
        rows={roomy ? 3 : 1}
        value={prompt}
        onChange={(e) => {
          onPrompt(e.target.value);
          setCaret(e.target.selectionStart);
          setHighlight(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label="Goal"
      />
      <div className="composer-bar">
        <div className="add">
          <button type="button" className="icon-button" aria-label="Add a file or folder" aria-expanded={adding} onClick={() => setAdding(!adding)}>
            <Icon name="plus" />
          </button>
          {adding && (
            <div className="add-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setAdding(false); onBrowse(false); }}>
                <Icon name="file" size={14} />
                Files…
              </button>
              <button type="button" role="menuitem" onClick={() => { setAdding(false); onBrowse(true); }}>
                <Icon name="folder" size={14} />
                Folder…
              </button>
            </div>
          )}
        </div>
        {roomy && <span className="composer-hint">@ for apps and files</span>}
        <span className="spacer" />
        <button className="send" type="submit" aria-label="Review plan" disabled={!prompt.trim() || busy}>
          <Icon name="send" />
        </button>
      </div>
    </form>
  );
}

/** One handed-over file or folder. The folder a mission runs in is marked as its project. */
export function ContextCard({ item, project, onRemove }: { item: ContextItem; project: boolean; onRemove: () => void }) {
  return (
    <div className={`context-card ${item.kind}`} title={item.path}>
      <span className={`context-icon ${item.kind}`}>
        <Icon name={KIND_ICON[item.kind]} size={16} />
      </span>
      <span className="context-text">
        <strong>{item.name}</strong>
        <span>{project ? `Project · ${item.detail}` : item.kind === "folder" && !item.project ? `Not a project · ${item.detail}` : item.detail}</span>
      </span>
      <button type="button" className="context-remove" aria-label={`Remove ${item.name}`} onClick={onRemove}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

type ComposeProps = {
  context: ContextItem[];
  project: string | null;
  onRemove: (path: string) => void;
  onClear: () => void;
  onBack: () => void;
  onApps: () => void;
  composer: ReactNode;
};

/** A new mission around what you dropped: the context it will read, then the goal. */
export function ComposeView({ context, project, onRemove, onClear, onBack, onApps, composer }: ComposeProps) {
  return (
    <div className="compose-view">
      <header className="view-head">
        <button className="back" onClick={onBack}>
          <Icon name="back" />
          Agents
        </button>
        <strong className="view-title">New mission</strong>
        <button className="pill-button" onClick={onApps}>
          <Icon name="shield" size={14} />
          Apps
        </button>
      </header>

      <section className="view-section">
        <div className="section-head">
          <h3>Context · {context.length}</h3>
          {context.length > 0 && (
            <button className="text-button" onClick={onClear}>
              Clear
            </button>
          )}
        </div>
        {context.length > 0 ? (
          <div className="context-grid">
            {context.map((item) => (
              <ContextCard key={item.path} item={item} project={item.path === project} onRemove={() => onRemove(item.path)} />
            ))}
          </div>
        ) : (
          <p className="view-empty">Drop files or a project folder here, or add them with +.</p>
        )}
        {project && <p className="view-note">Runs in {context.find((c) => c.path === project)?.name}; everything else is read as context.</p>}
        {context
          .filter((c) => c.kind === "folder" && !c.project)
          .map((c) => (
            <p key={c.path} className="view-note">
              {c.name} isn't a code project, so it's only looked at: nothing in it is changed.
            </p>
          ))}
      </section>

      {composer}
    </div>
  );
}

type ReviewProps = {
  goal: string;
  preview: Preview;
  context: ContextItem[];
  starting: boolean;
  onEdit: () => void;
  onStart: () => void;
  onAccess: () => void;
};

const TONE_CLASS = { auto: "auto", asks: "asks", read: "read" } as const;

/** What the goal will start, before it does: who, where, with what access and why. */
export function ReviewView({ goal, preview, context, starting, onEdit, onStart, onAccess }: ReviewProps) {
  const steps = planSteps(preview, context);
  return (
    <div className="review-view">
      <header className="view-head">
        <button className="back" onClick={onEdit}>
          <Icon name="back" />
          Back
        </button>
        <strong className="view-title">Review plan</strong>
        <span className="view-head-spacer" />
      </header>

      <div className="review-body">
        <p className="review-goal">{goal}</p>
        {preview.decision.access === "readOnly" &&
          context
            .filter((c) => c.kind === "folder" && !c.project)
            .slice(0, 1)
            .map((c) => <FolderChips key={c.path} item={c} model={preview.model} />)}
        {context.length > 0 && (
          <div className="context-chips">
            {context.map((item) => (
              <span key={item.path} className="context-chip" title={item.path}>
                <span className={`context-icon small ${item.kind}`}>
                  <Icon name={KIND_ICON[item.kind]} size={10} />
                </span>
                {item.name}
              </span>
            ))}
          </div>
        )}

        <section className="view-section">
          <div className="section-head">
            <h3>Plan</h3>
            <button className="text-button link-blue" onClick={onAccess}>
              Change access
            </button>
          </div>
          <ol className="plan">
            {steps.map((step, i) => (
              <li key={step.title}>
                <div className="plan-rail">
                  <span className="plan-number">{i + 1}</span>
                  {i < steps.length - 1 && <span className="plan-line" />}
                </div>
                <div className="plan-step">
                  <div className="plan-who">
                    <BlobAvatar role={step.role} state="idle" size={20} />
                    <span>{step.agent}</span>
                    {step.where && (
                      <>
                        <Icon name="chevron" size={12} className="plan-arrow" />
                        <span>{step.where}</span>
                      </>
                    )}
                    <span className="spacer" />
                    <span className={`access-badge ${TONE_CLASS[step.badge.tone]}`}>{step.badge.label}</span>
                  </div>
                  <strong>{step.title}</strong>
                  <p>{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="view-note mono">
            {preview.model} · {preview.decision.tier} model
          </p>
        </section>
      </div>

      <div className="review-actions">
        <button className="secondary" onClick={onEdit}>
          Edit
        </button>
        <button className="primary" onClick={onStart} disabled={starting}>
          {starting ? "Starting…" : "Start mission"}
        </button>
      </div>
    </div>
  );
}

type AppsProps = {
  apps: App[] | null;
  loading: boolean;
  error: string | null;
  access: Record<string, AppAccess>;
  onAccess: (app: App, access: AppAccess) => void;
  onRefresh: () => void;
  onBack: () => void;
};

const LEVELS: { value: AppAccess; label: string }[] = [
  { value: "read", label: "Read" },
  { value: "ask", label: "Ask" },
  { value: "act", label: "Act" },
];

/** The apps agents can work in, and how much they may do in each without asking. */
export function AppsView({ apps, loading, error, access, onAccess, onRefresh, onBack }: AppsProps) {
  const connected = apps?.filter((a) => a.status === "connected") ?? [];
  const signIn = apps?.filter((a) => a.status === "needsAuth") ?? [];
  const failed = apps?.filter((a) => a.status === "failed") ?? [];

  return (
    <div className="apps-view">
      <header className="view-head">
        <button className="back" onClick={onBack}>
          <Icon name="back" />
          Back
        </button>
        <strong className="view-title">Apps &amp; access</strong>
        <button className="icon-button" onClick={onRefresh} disabled={loading} aria-label="Check apps again">
          <Icon name="refresh" className={loading ? "spinning" : ""} />
        </button>
      </header>

      <div className="apps-body">
        {error && <p className="view-note error">{error}</p>}
        {!apps && loading && <p className="view-empty">Checking which apps are connected…</p>}

        {connected.length > 0 && (
          <section className="view-section">
            <div className="section-head">
              <h3>Connected</h3>
            </div>
            <ul className="app-list">
              {connected.map((app) => {
                const level = access[app.id] ?? "ask";
                return (
                  <li key={app.id}>
                    <AppMark name={app.name} />
                    <span className="app-text">
                      <strong>{app.name}</strong>
                      <span>{LEVEL_NOTE[level]}</span>
                    </span>
                    <div className="segmented" role="radiogroup" aria-label={`What agents may do in ${app.name}`}>
                      {LEVELS.map((l) => (
                        <button key={l.value} role="radio" aria-checked={level === l.value} onClick={() => onAccess(app, l.value)}>
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {signIn.length > 0 && (
          <section className="view-section">
            <div className="section-head">
              <h3>Needs sign-in</h3>
            </div>
            <ul className="app-list">
              {signIn.map((app) => (
                <li key={app.id} className="muted">
                  <AppMark name={app.name} />
                  <span className="app-text">
                    <strong>{app.name}</strong>
                    <span>Sign in on claude.ai to let agents use it</span>
                  </span>
                  <button className="pill-button" onClick={() => openUrl(CONNECTORS_URL)}>
                    Sign in
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {failed.length > 0 && (
          <section className="view-section">
            <div className="section-head">
              <h3>Not reachable</h3>
            </div>
            <ul className="app-list">
              {failed.map((app) => (
                <li key={app.id} className="muted">
                  <AppMark name={app.name} />
                  <span className="app-text">
                    <strong>{app.name}</strong>
                    <span>Couldn't connect just now</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {apps && apps.length === 0 && (
          <p className="view-empty">
            No apps yet. Connect Notion, Gmail and others on claude.ai and they show up here.{" "}
            <button className="text-button link-blue" onClick={() => openUrl(CONNECTORS_URL)}>
              Open connectors
            </button>
          </p>
        )}
      </div>

      <p className="apps-legend">
        <Icon name="shield" size={13} />
        Read: look only · Ask: you approve each change · Act: changes go ahead on their own
      </p>
    </div>
  );
}

const LEVEL_NOTE: Record<AppAccess, string> = {
  read: "Agents can look, never change",
  ask: "Asks before creating, changing or sending",
  act: "Creates, changes and sends on its own",
};

/** A small lettered tile standing in for an app's logo, coloured by its name. */
function AppMark({ name, size = 32 }: { name: string; size?: number }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      className="app-mark"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 45% 22%)`, color: `hsl(${hue} 80% 80%)` }}
      aria-hidden="true"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
