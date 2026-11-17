import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useBackend } from "./backend";
import { Icon } from "./Icon";
import { parseDiff } from "./git/diff";
import { gitRulesSentence, syncLabel } from "./git/summary";
import type { ChangeKind, FileChange, PullRequest, RepoStatus, Settings } from "./types";
import "./changes.css";

const KIND: Record<ChangeKind, { letter: string; label: string }> = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  copied: { letter: "C", label: "Copied" },
  typeChanged: { letter: "T", label: "Type changed" },
  untracked: { letter: "U", label: "New file" },
  conflicted: { letter: "!", label: "Conflict" },
};

const REFRESH_MS = 4000;
const LAST_FOLDER_KEY = "mc.changes.folder";
const OPEN_ANOTHER = "mc:open-another-folder";

type Selected = { path: string; staged: boolean };
type Notice = { kind: "ok" | "error"; text: string } | null;
type Act = (label: string, command: string, args?: Record<string, unknown>, done?: string) => Promise<boolean>;

/** Git and GitHub for the folders agents work in: review, stage, commit, push, branch, open PRs. */
export default function ChangesPanel({ folders }: { folders: string[] }) {
  const [stored, setStored] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_FOLDER_KEY);
    } catch {
      return null;
    }
  });
  const folder = stored ?? folders[0] ?? null;
  const all = folder && !folders.includes(folder) ? [folder, ...folders] : folders;

  function choose(next: string) {
    setStored(next);
    try {
      localStorage.setItem(LAST_FOLDER_KEY, next);
    } catch {
      // Remembering the folder is a convenience; without storage it is simply not remembered.
    }
  }

  async function browse() {
    const picked = await pickFolder({ directory: true, multiple: false, title: "Open a project" });
    if (typeof picked === "string") choose(picked);
  }

  if (!folder) {
    return (
      <div className="ch">
        <header className="ch-head">
          <div className="ch-title">
            <h1>Changes</h1>
            <p className="ch-meta">Projects agents work in show up here, with what they changed.</p>
          </div>
        </header>
        <div className="ch-card ch-empty">
          <p>Choose a project folder to review its changes.</p>
          <button className="ch-btn" onClick={browse}>
            Choose a folder
          </button>
        </div>
      </div>
    );
  }

  const picker = <ProjectPicker folder={folder} folders={all} onChoose={choose} onBrowse={browse} />;
  return <Repo key={folder} folder={folder} picker={picker} />;
}

/** The heading is the project switcher: the Desk sidebar's project list belongs to the shell. */
function ProjectPicker(props: { folder: string; folders: string[]; onChoose: (f: string) => void; onBrowse: () => void }) {
  return (
    <h1 className="ch-project">
      <select
        aria-label="Project"
        title={props.folder}
        value={props.folder}
        onChange={(e) => (e.target.value === OPEN_ANOTHER ? props.onBrowse() : props.onChoose(e.target.value))}
      >
        {props.folders.map((f) => (
          <option key={f} value={f}>
            {baseName(f)}
          </option>
        ))}
        <option value={OPEN_ANOTHER}>Open another folder…</option>
      </select>
      <Chevron />
    </h1>
  );
}

function Repo({ folder, picker }: { folder: string; picker: ReactNode }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [notRepo, setNotRepo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [message, setMessage] = useState("");
  const settings = useBackend<Settings | null>("get_settings", "settings-updated", null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<RepoStatus>("git_status", { folder }));
      setNotRepo(null);
    } catch (err) {
      setStatus(null);
      setNotRepo(String(err));
    }
  }, [folder]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  /** Runs one git action at a time, reports the outcome and refreshes the status. */
  const act: Act = async (label, command, args = {}, done) => {
    setBusy(label);
    setNotice(null);
    try {
      const result = await invoke<unknown>(command, { folder, ...args });
      if (done) setNotice({ kind: "ok", text: typeof result === "string" && result ? `${done} ${result}` : done });
      return true;
    } catch (err) {
      setNotice({ kind: "error", text: String(err) });
      return false;
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const noticeBar = notice && (
    <div className={`ch-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      <span>{notice.text}</span>
      <button className="ch-icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );

  if (notRepo || !status) {
    return (
      <div className="ch">
        <header className="ch-head">
          <div className="ch-title">
            {picker}
            <p className="ch-meta mc-mono" title={folder}>
              {folder}
            </p>
          </div>
        </header>
        {noticeBar}
        {notRepo && (
          <div className="ch-card ch-empty">
            <p>This folder isn't a git repository yet, so there are no changes to review.</p>
            <p className="ch-faint">{notRepo}</p>
            <button className="ch-btn primary" disabled={busy !== null} onClick={() => act("init", "git_init", {}, "Created a repository.")}>
              {busy === "init" ? "Creating…" : "Initialise a repository here"}
            </button>
          </div>
        )}
      </div>
    );
  }

  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => f.unstaged);
  const stillThere = selected && (selected.staged ? staged : unstaged).some((f) => f.path === selected.path);
  // Keep a diff on screen: fall back to the first file when the chosen one is committed or reverted.
  const current: Selected | null = stillThere
    ? selected
    : staged[0]
      ? { path: staged[0].path, staged: true }
      : unstaged[0]
        ? { path: unstaged[0].path, staged: false }
        : null;
  const canCommit = staged.length > 0 && message.trim() !== "" && !busy;

  async function commit() {
    if (canCommit && (await act("commit", "git_commit", { message }, "Committed"))) setMessage("");
  }

  const published = status.upstream !== null;
  const pushLabel = !published ? "Publish branch" : status.ahead > 0 ? `Push ${status.ahead}` : "Push";

  return (
    <div className="ch">
      <header className="ch-head">
        <div className="ch-title">
          {picker}
          <div className="ch-meta">
            <BranchSwitcher status={status} folder={folder} busy={busy} act={act} />
            <span title={status.upstream ?? undefined}>{syncLabel(status)}</span>
          </div>
        </div>
        <div className="ch-actions">
          <button className="ch-btn" disabled={busy !== null || !published} onClick={() => act("fetch", "git_fetch", {}, "Fetched.")}>
            {busy === "fetch" ? "Fetching…" : "Fetch"}
          </button>
          <button className="ch-btn" disabled={busy !== null || !published || status.behind === 0} onClick={() => act("pull", "git_pull", {}, "Pulled.")}>
            {busy === "pull" ? "Pulling…" : status.behind > 0 ? `Pull ${status.behind}` : "Pull"}
          </button>
          <button
            className="ch-btn strong"
            disabled={busy !== null || status.unborn || status.remotes.length === 0 || (published && status.ahead === 0)}
            title={status.remotes.length === 0 ? "This repository has no remote" : undefined}
            onClick={() => act("push", "git_push", {}, published ? "Pushed." : "Published the branch.")}
          >
            {busy === "push" ? "Pushing…" : pushLabel}
          </button>
        </div>
      </header>

      {noticeBar}

      <div className="ch-body">
        <div className="ch-side">
          <div className="ch-card ch-files">
            {status.files.length === 0 ? (
              <p className="ch-files-empty">No changes. The working tree matches the last commit.</p>
            ) : (
              <>
                <FileGroup
                  title="Staged"
                  files={staged}
                  staged
                  current={current}
                  busy={busy !== null}
                  onSelect={setSelected}
                  bulkLabel="Unstage all"
                  onBulk={() => act("unstage", "git_unstage", { paths: [] })}
                  onToggle={(f) => act("unstage", "git_unstage", { paths: [f.path] })}
                />
                <FileGroup
                  title="Not staged"
                  files={unstaged}
                  staged={false}
                  current={current}
                  busy={busy !== null}
                  onSelect={setSelected}
                  bulkLabel="Stage all"
                  onBulk={() => act("stage", "git_stage", { paths: [] })}
                  onToggle={(f) => act("stage", "git_stage", { paths: [f.path] })}
                />
              </>
            )}
          </div>

          <form
            className="ch-card ch-commit"
            onSubmit={(e) => {
              e.preventDefault();
              commit();
            }}
          >
            <label htmlFor="ch-commit-message" className="mc-label">
              Commit
            </label>
            <textarea
              id="ch-commit-message"
              rows={3}
              value={message}
              placeholder="What changed and why"
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  commit();
                }
              }}
            />
            <button className="ch-btn primary" type="submit" disabled={!canCommit}>
              {busy === "commit"
                ? "Committing…"
                : staged.length === 0
                  ? "Stage files to commit"
                  : `Commit ${staged.length} ${staged.length === 1 ? "file" : "files"}`}
            </button>
          </form>

          <PullRequestCard status={status} folder={folder} busy={busy} act={act} />
        </div>

        <section className="ch-card ch-diff" aria-label="Diff">
          <Diff folder={folder} selected={current} status={status} />
          {settings && (
            <footer className="ch-rules">
              <Icon name="shield" size={14} />
              <span>{gitRulesSentence(settings, status.branch)}</span>
            </footer>
          )}
        </section>
      </div>
    </div>
  );
}

function BranchSwitcher({ status, folder, busy, act }: { status: RepoStatus; folder: string; busy: string | null; act: Act }) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [name, setName] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    invoke<string[]>("git_branches", { folder }).then(setBranches, () => setBranches([]));
  }, [folder, status.branch, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const list = branches.length ? branches : status.branch ? [status.branch] : [];

  async function switchTo(branch: string) {
    setOpen(false);
    if (branch !== status.branch) await act("switch", "git_switch_branch", { name: branch }, `Switched to ${branch}.`);
  }

  return (
    <div className="ch-branch" ref={root}>
      <button ref={toggle} className="ch-branch-btn" aria-haspopup="true" aria-expanded={open} aria-label={`Branch: ${status.branch ?? "detached HEAD"}`} onClick={() => setOpen(!open)}>
        <Icon name="branch" size={13} />
        <span className="mc-mono">{status.branch ?? "Detached HEAD"}</span>
        <Chevron />
      </button>
      {open && (
        <div className="ch-branch-pop" role="dialog" aria-label="Branches">
          <span className="mc-label">Switch branch</span>
          <ul>
            {list.map((b) => (
              <li key={b}>
                <button aria-current={b === status.branch ? "true" : undefined} disabled={busy !== null || status.unborn} onClick={() => switchTo(b)}>
                  <span className="mc-mono">{b}</span>
                  {b === status.branch && <Icon name="check" size={14} />}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="ch-new-branch"
            onSubmit={async (e) => {
              e.preventDefault();
              const branch = name.trim();
              if (!branch) return;
              if (await act("branch", "git_create_branch", { name: branch }, `Switched to new branch ${branch}.`)) {
                setName("");
                setOpen(false);
              }
            }}
          >
            <input className="mc-mono" value={name} placeholder="feature/name" aria-label="New branch name" onChange={(e) => setName(e.target.value)} />
            <button className="ch-btn small" type="submit" disabled={!name.trim() || busy !== null}>
              Create
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function FileGroup(props: {
  title: string;
  files: FileChange[];
  staged: boolean;
  current: Selected | null;
  busy: boolean;
  onSelect: (s: Selected) => void;
  bulkLabel: string;
  onBulk: () => void;
  onToggle: (f: FileChange) => void;
}) {
  return (
    <div className="ch-group">
      <div className="ch-group-head">
        <span className="mc-label">
          {props.title} · {props.files.length}
        </span>
        {props.files.length > 0 && (
          <button className="ch-link" onClick={props.onBulk} disabled={props.busy}>
            {props.bulkLabel}
          </button>
        )}
      </div>
      <ul>
        {props.files.map((f) => {
          const kind = (props.staged ? f.staged : f.unstaged)!;
          const on = props.current?.path === f.path && props.current.staged === props.staged;
          return (
            <li key={f.path} className={on ? "on" : ""}>
              <input
                type="checkbox"
                checked={props.staged}
                disabled={props.busy}
                aria-label={`${props.staged ? "Unstage" : "Stage"} ${f.path}`}
                onChange={() => props.onToggle(f)}
              />
              <button
                className="ch-file"
                aria-pressed={on}
                onClick={() => props.onSelect({ path: f.path, staged: props.staged })}
                title={f.original ? `${f.original} → ${f.path}` : f.path}
              >
                <span className={`ch-kind ${kind}`} title={KIND[kind].label} aria-label={KIND[kind].label}>
                  {KIND[kind].letter}
                </span>
                <span className="mc-mono ch-path">{f.path}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Diff({ folder, selected, status }: { folder: string; selected: Selected | null; status: RepoStatus }) {
  const [loaded, setLoaded] = useState<{ id: string; text: string } | null>(null);
  // Refetch when the file's state changes, e.g. after an agent edits it again.
  const version = status.files.find((f) => f.path === selected?.path);
  const key = version ? `${version.staged}:${version.unstaged}` : "";
  const path = selected?.path;
  const staged = selected?.staged;
  const id = `${staged}:${path}`;
  // A diff fetched for another file is never shown, even for the moment before the new one loads.
  const text = loaded?.id === id ? loaded.text : null;

  useEffect(() => {
    if (path === undefined) return;
    let live = true;
    invoke<string>("git_diff", { folder, path, staged }).then(
      (diff) => live && setLoaded({ id, text: diff }),
      (err) => live && setLoaded({ id, text: String(err) }),
    );
    return () => {
      live = false;
    };
  }, [folder, path, staged, id, key]);

  const diff = useMemo(() => parseDiff(text ?? ""), [text]);

  if (!selected) {
    return <div className="ch-diff-empty">Nothing to review. Changes agents make show up here.</div>;
  }
  return (
    <>
      <div className="ch-diff-head">
        <span className="mc-mono ch-path">{selected.path}</span>
        <span className="ch-tag">{selected.staged ? "Staged" : "Not staged"}</span>
        <span className="mc-mono ch-added">+{diff.added}</span>
        <span className="mc-mono ch-removed">−{diff.removed}</span>
      </div>
      <div className="ch-diff-body mc-mono" tabIndex={0} aria-label={`Changes in ${selected.path}`}>
        <div className="ch-diff-lines">
          {text !== null && diff.lines.length === 0 && <div className="ch-ln note">No differences to show.</div>}
          {diff.lines.map((line, i) => (
            <div key={i} className={`ch-ln ${line.kind}`}>
              <span className="ch-no">{line.kind === "hunk" ? "@@" : (line.number ?? "")}</span>
              <span className="ch-sign" aria-hidden="true">
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
              </span>
              <span className="ch-code">{line.text || " "}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function PullRequestCard({ status, folder, busy, act }: { status: RepoStatus; folder: string; busy: string | null; act: Act }) {
  const [pr, setPr] = useState<PullRequest | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const usable = status.remotes.length > 0 && !status.unborn;

  const load = useCallback(() => {
    invoke<PullRequest | null>("github_pull_request", { folder }).then(
      (found) => {
        setPr(found);
        setProblem(null);
      },
      (err) => setProblem(String(err)),
    );
  }, [folder]);

  // Only on branch or publish changes: each check asks GitHub over the network.
  useEffect(() => {
    if (usable) load();
  }, [load, usable, status.branch, status.upstream]);

  function startWriting() {
    if (!title) setTitle(titleFromBranch(status.branch ?? ""));
    setWriting(true);
  }

  let content: ReactNode;
  if (status.unborn) content = <p className="ch-muted">Make a first commit to open a pull request.</p>;
  else if (status.remotes.length === 0) content = <p className="ch-muted">This repository has no remote, so there is nowhere to open one.</p>;
  else if (problem) content = <p className="ch-muted">{problem}</p>;
  else if (pr === undefined) content = <p className="ch-muted">Checking GitHub…</p>;
  else if (pr)
    content = (
      <div className="ch-pr">
        <div className="ch-pr-line">
          <span className={`ch-pr-state ${pr.isDraft ? "draft" : pr.state.toLowerCase()}`}>{pr.isDraft ? "Draft" : titleCase(pr.state)}</span>
          <span className="ch-pr-title">
            #{pr.number} {pr.title}
          </span>
        </div>
        <button className="ch-btn" onClick={() => openUrl(pr.url)}>
          Open on GitHub
        </button>
      </div>
    );
  else if (status.upstream === null) content = <p className="ch-muted">Publish the branch to open a pull request.</p>;
  else if (!writing)
    content = (
      <>
        <p className="ch-text">No pull request for this branch yet.</p>
        <div className="ch-pr-row">
          <button className="ch-btn grow" onClick={startWriting} disabled={busy !== null}>
            Open pull request
          </button>
          <label className="ch-check">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Draft
          </label>
        </div>
      </>
    );
  else
    content = (
      <form
        className="ch-pr-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await act("pr", "github_create_pull_request", { title, body, draft }, "Opened")) {
            setTitle("");
            setBody("");
            setWriting(false);
            load();
          }
        }}
      >
        <input autoFocus value={title} placeholder="Title" aria-label="Pull request title" onChange={(e) => setTitle(e.target.value)} />
        <textarea rows={3} value={body} placeholder="Description (optional)" aria-label="Pull request description" onChange={(e) => setBody(e.target.value)} />
        <div className="ch-pr-row">
          <button className="ch-btn" type="button" onClick={() => setWriting(false)}>
            Cancel
          </button>
          <label className="ch-check">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Draft
          </label>
          <button className="ch-btn primary grow" type="submit" disabled={!title.trim() || busy !== null}>
            {busy === "pr" ? "Opening…" : draft ? "Open draft" : "Open pull request"}
          </button>
        </div>
      </form>
    );

  return (
    <div className="ch-card ch-prcard">
      <span className="mc-label">Pull request</span>
      {content}
    </div>
  );
}

function Chevron() {
  return (
    <svg className="ch-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** "fix/login-cookie" becomes "Fix login cookie", a starting point for the title. */
function titleFromBranch(branch: string) {
  const words = (branch.split("/").pop() ?? "").replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function titleCase(word: string) {
  return word.charAt(0) + word.slice(1).toLowerCase();
}
