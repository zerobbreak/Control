// The goal card: what you handed over as chips, the goal itself, and the plan line that says who
// will do it before anything runs.

import { useRef, useState, type KeyboardEvent } from "react";
import { insertMention, mentionAt, mentionOptions, type Mention } from "./context";
import { Face, RoleGlyph } from "./Face";
import { Icon, type ICONS } from "./Icon";
import { planLine } from "./island/island";
import type { App, ContextItem, Preview } from "./types";

const KIND_ICON: Record<ContextItem["kind"], keyof typeof ICONS> = {
  folder: "folder",
  image: "image",
  pdf: "pdf",
  link: "link",
  file: "file",
  missing: "x",
};

// Chips beyond this collapse into "+N", so the card keeps one header line.
const MAX_CHIPS = 3;

type ComposeProps = {
  prompt: string;
  onPrompt: (text: string) => void;
  context: ContextItem[];
  /** The folder the goal runs in, shown as the project chip. */
  project: string | null;
  onRemove: (path: string) => void;
  onBrowse: (directory: boolean) => void;
  apps: App[];
  /** The plan for the current goal and context, or null until Enter asks for it. */
  preview: Preview | null;
  busy: boolean;
  error: string | null;
  /** Enter: plans the goal, or starts it once it is planned. */
  onEnter: () => void;
  onGo: () => void;
  onDesk: () => void;
  onQuit: () => void;
};

/**
 * The goal card. Typing `@` offers connected apps and handed-over files; picking one writes its
 * name into the goal, which is also how the router tells an errand in Notion from code work.
 */
export function ComposeCard(props: ComposeProps) {
  const { prompt, onPrompt, context, project, onRemove, onBrowse, apps, preview, busy, error, onEnter, onGo, onDesk, onQuit } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [adding, setAdding] = useState(false);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const mention = mentionAt(prompt, caret);
  const options = mention && dismissed !== mention.start ? mentionOptions(mention.query, apps, context, 4) : [];
  const shown = context.slice(0, MAX_CHIPS);
  const plan = preview ? planLine(preview) : null;

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
        // Closes the menu without tucking the island away.
        e.stopPropagation();
        setDismissed(mention!.start);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onEnter();
    }
  }

  return (
    <form
      className="card compose"
      aria-label="New goal"
      onSubmit={(e) => {
        e.preventDefault();
        onGo();
      }}
    >
      <header className="card-head">
        <Face state={busy ? "thinking" : "idle"} />
        <span className="chips">
          {shown.map((item) => (
            <span key={item.path} className={`chip ${item.path === project ? "project" : ""} ${item.kind === "missing" ? "missing" : ""}`} title={`${item.path}\n${item.detail}`}>
              {item.path !== project && <Icon name={KIND_ICON[item.kind]} size={11} />}
              <span className="chip-name">{item.name}</span>
              <button type="button" className="chip-x" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.path)}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
          {context.length > MAX_CHIPS && (
            <span className="chip more" title={context.slice(MAX_CHIPS).map((c) => c.name).join("\n")}>
              +{context.length - MAX_CHIPS}
            </span>
          )}
        </span>
        <button type="button" className="icon-btn meta" aria-label="Add a file or folder" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          <Icon name={adding ? "x" : "plus"} size={13} />
        </button>
        <button type="button" className="icon-btn" aria-label="Open the Desk" title="Open the Desk" onClick={onDesk}>
          <Icon name="open" size={13} />
        </button>
        <button type="button" className="icon-btn" aria-label="Quit Mission Control" title="Quit Mission Control" onClick={onQuit}>
          <Icon name="power" size={13} />
        </button>
      </header>

      {adding && (
        <div className="add-row" role="group" aria-label="Add context">
          <button type="button" className="btn small" onClick={() => { setAdding(false); onBrowse(false); }}>
            <Icon name="file" size={13} />
            Files…
          </button>
          <button type="button" className="btn small" onClick={() => { setAdding(false); onBrowse(true); }}>
            <Icon name="folder" size={13} />
            Folder…
          </button>
        </div>
      )}

      <textarea
        ref={field}
        autoFocus
        rows={2}
        value={prompt}
        onChange={(e) => {
          onPrompt(e.target.value);
          setCaret(e.target.selectionStart);
          setHighlight(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        placeholder={context.length > 0 ? "What should happen with these?" : "Give it a goal, or drop a file or folder"}
        aria-label="Goal"
      />

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
              <span className="mention-mark" aria-hidden="true">
                {option.kind === "app" ? option.name.charAt(0).toUpperCase() : <Icon name="file" size={11} />}
              </span>
              <strong>{option.name}</strong>
              <span>{option.detail}</span>
            </button>
          ))}
        </div>
      )}

      <div className="compose-foot">
        {error ? (
          <span className="plan error" role="alert">
            {error}
          </span>
        ) : plan ? (
          <span className="plan" title={preview?.decision.reason}>
            <RoleGlyph role={plan.role} />
            {plan.text}
          </span>
        ) : busy ? (
          <span className="plan hint" role="status">Working out who should do this…</span>
        ) : (
          <span className="plan hint">{prompt.trim() ? "Enter to see who will do it" : "@ for apps and files"}</span>
        )}
        <button type="submit" className="btn primary go" disabled={!prompt.trim() || busy} aria-busy={busy}>
          Go
        </button>
      </div>
    </form>
  );
}
