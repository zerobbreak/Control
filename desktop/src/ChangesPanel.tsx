import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ChangeKind, FileChange, PullRequest, RepoStatus } from "./types";

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

type Selected = { path: string; staged: boolean };
type Notice = { kind: "ok" | "error"; text: string } | null;

/** Git and GitHub for the folders agents work in: review, stage, commit, push, branch, open PRs. */
export default function ChangesPanel({ folders }: { folders: string[] }) {
  const [folder, setFolder] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_FOLDER_KEY);
    } catch {
      return null;
    }
  });
  const [typed, setTyped] = useState("");
  const all = folder && !folders.includes(folder) ? [folder, ...folders] : folders;

  function choose(next: string) {
    setFolder(next);
    try {
      localStorage.setItem(LAST_FOLDER_KEY, next);
    } catch {
      // Remembering the folder is a convenience; without storage it is simply not remembered.
    }
  }

  return (
    <div className="changes">
      <aside className="folders">
        <h2>Folders</h2>
        {all.length === 0 && <p className="empty">Folders agents work in show up here.</p>}
        <ul>
          {all.map((f) => (
            <li key={f}>
              <button className={f === folder ? "on" : ""} title={f} onClick={() => choose(f)}>
                <strong>{baseName(f)}</strong>
                <span>{f}</span>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="add"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) choose(typed.trim());
            setTyped("");
          }}
        >
          <input className="mono" value={typed} placeholder="C:\path\to\repo" aria-label="Open a folder" onChange={(e) => setTyped(e.target.value)} />
          <button type="submit" disabled={!typed.trim()}>
            Open
          </button>
        </form>
      </aside>
      {folder ? <Repo key={folder} folder={folder} /> : <div className="repo empty-state">Choose a folder to see its changes.</div>}
    </div>
  );
}

function Repo({ folder }: { folder: string }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [notRepo, setNotRepo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [message, setMessage] = useState("");

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
  async function act(label: string, command: string, args: Record<string, unknown> = {}, done?: string) {
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
  }

  if (notRepo) {
    return (
      <div className="repo empty-state">
        <p>{notRepo}</p>
        <button className="primary-button" disabled={busy !== null} onClick={() => act("init", "git_init", {}, "Created a repository.")}>
          Initialise a repository here
        </button>
      </div>
    );
  }
  if (!status) return <div className="repo" />;

  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => f.unstaged);
  const canCommit = staged.length > 0 && message.trim() !== "" && !busy;

  return (
    <div className="repo">
      <BranchBar status={status} folder={folder} busy={busy} act={act} />
      {notice && (
        <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}
          <button aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <div className="repo-body">
        <div className="repo-files">
          <FileList
            title="Staged"
            files={staged}
            staged
            selected={selected}
            onSelect={setSelected}
            bulkLabel="Unstage all"
            onBulk={() => act("unstage", "git_unstage", { paths: [] })}
            onOne={(f) => act("unstage", "git_unstage", { paths: [f.path] })}
            busy={busy !== null}
          />
          <FileList
            title="Changes"
            files={unstaged}
            staged={false}
            selected={selected}
            onSelect={setSelected}
            bulkLabel="Stage all"
            onBulk={() => act("stage", "git_stage", { paths: [] })}
            onOne={(f) => act("stage", "git_stage", { paths: [f.path] })}
            busy={busy !== null}
          />
          {status.files.length === 0 && <p className="empty">No changes. The working tree matches the last commit.</p>}

          <form
            className="commit"
            onSubmit={async (e) => {
              e.preventDefault();
              if (canCommit && (await act("commit", "git_commit", { message }, "Committed"))) setMessage("");
            }}
          >
            <label htmlFor="commit-message">Commit message</label>
            <textarea
              id="commit-message"
              rows={3}
              value={message}
              placeholder="What changed and why"
              onChange={(e) => setMessage(e.target.value)}
            />
            <button className="primary-button" type="submit" disabled={!canCommit}>
              {busy === "commit" ? "Committing…" : `Commit ${staged.length} ${staged.length === 1 ? "file" : "files"}`}
            </button>
          </form>

          <GitHub status={status} folder={folder} busy={busy} act={act} />
        </div>
        <Diff folder={folder} selected={selected} status={status} />
      </div>
    </div>
  );
}

type Act = (label: string, command: string, args?: Record<string, unknown>, done?: string) => Promise<boolean>;

function BranchBar({ status, folder, busy, act }: { status: RepoStatus; folder: string; busy: string | null; act: Act }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    invoke<string[]>("git_branches", { folder }).then(setBranches, () => setBranches([]));
  }, [folder, status.branch]);

  const published = status.upstream !== null;
  const pushLabel = !published ? "Publish branch" : status.ahead > 0 ? `Push ${status.ahead}` : "Push";

  return (
    <header className="branch-bar">
      <div className="repo-name" title={status.root}>
        {baseName(status.root)}
      </div>
      {naming ? (
        <form
          className="new-branch"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act("branch", "git_create_branch", { name }, `Switched to new branch ${name.trim()}.`)) {
              setNaming(false);
              setName("");
            }
          }}
        >
          <input className="mono" autoFocus value={name} placeholder="feature/name" aria-label="New branch name" onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={!name.trim() || busy !== null}>
            Create
          </button>
          <button type="button" onClick={() => setNaming(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <select
            aria-label="Branch"
            value={status.branch ?? ""}
            disabled={busy !== null || status.unborn}
            onChange={(e) => act("switch", "git_switch_branch", { name: e.target.value }, `Switched to ${e.target.value}.`)}
          >
            {status.branch === null && <option value="">Detached HEAD</option>}
            {(branches.length ? branches : status.branch ? [status.branch] : []).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <button className="ghost-button" onClick={() => setNaming(true)} disabled={busy !== null}>
            New branch
          </button>
        </>
      )}
      <span className="sync" title={status.upstream ?? "Not published yet"}>
        {published ? `↑${status.ahead} ↓${status.behind}` : "Not published"}
      </span>
      <span className="spacer" />
      <button className="ghost-button" disabled={busy !== null || !published} onClick={() => act("fetch", "git_fetch", {}, "Fetched.")}>
        {busy === "fetch" ? "Fetching…" : "Fetch"}
      </button>
      <button
        className="ghost-button"
        disabled={busy !== null || !published || status.behind === 0}
        onClick={() => act("pull", "git_pull", {}, "Pulled.")}
      >
        {busy === "pull" ? "Pulling…" : status.behind > 0 ? `Pull ${status.behind}` : "Pull"}
      </button>
      <button
        className="primary-button"
        disabled={busy !== null || status.unborn || status.remotes.length === 0 || (published && status.ahead === 0)}
        title={status.remotes.length === 0 ? "This repository has no remote" : undefined}
        onClick={() => act("push", "git_push", {}, published ? "Pushed." : "Published the branch.")}
      >
        {busy === "push" ? "Pushing…" : pushLabel}
      </button>
    </header>
  );
}

function FileList(props: {
  title: string;
  files: FileChange[];
  staged: boolean;
  selected: Selected | null;
  onSelect: (s: Selected) => void;
  bulkLabel: string;
  onBulk: () => void;
  onOne: (f: FileChange) => void;
  busy: boolean;
}) {
  if (props.files.length === 0) return null;
  return (
    <section className="file-list">
      <div className="section-head">
        <h2>
          {props.title} · {props.files.length}
        </h2>
        <button className="link" onClick={props.onBulk} disabled={props.busy}>
          {props.bulkLabel}
        </button>
      </div>
      <ul>
        {props.files.map((f) => {
          const kind = (props.staged ? f.staged : f.unstaged)!;
          const on = props.selected?.path === f.path && props.selected.staged === props.staged;
          return (
            <li key={f.path} className={on ? "on" : ""}>
              <button className="file" onClick={() => props.onSelect({ path: f.path, staged: props.staged })} title={f.original ? `${f.original} → ${f.path}` : f.path}>
                <span className={`kind ${kind}`} title={KIND[kind].label}>
                  {KIND[kind].letter}
                </span>
                <span className="mono path">{f.path}</span>
              </button>
              <button className="ghost-button small" onClick={() => props.onOne(f)} disabled={props.busy}>
                {props.staged ? "Unstage" : "Stage"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Diff({ folder, selected, status }: { folder: string; selected: Selected | null; status: RepoStatus }) {
  const [text, setText] = useState<string | null>(null);
  // Refetch when the file's state changes, e.g. after an agent edits it again.
  const version = status.files.find((f) => f.path === selected?.path);
  const key = version ? `${version.staged}:${version.unstaged}` : "";

  useEffect(() => {
    if (!selected) return;
    invoke<string>("git_diff", { folder, path: selected.path, staged: selected.staged }).then(setText, (err) => setText(String(err)));
  }, [folder, selected, key]);

  if (!selected) return <div className="diff empty-state">Select a file to see what changed.</div>;
  return (
    <div className="diff">
      <div className="diff-head mono">
        {selected.path} <span>{selected.staged ? "staged" : "not staged"}</span>
      </div>
      <pre>
        {(text ?? "").split("\n").map((line, i) => (
          <div key={i} className={lineClass(line)}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

function GitHub({ status, folder, busy, act }: { status: RepoStatus; folder: string; busy: string | null; act: Act }) {
  const [pr, setPr] = useState<PullRequest | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);

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
  useEffect(load, [load, status.branch, status.upstream]);

  if (status.remotes.length === 0 || status.unborn) return null;
  return (
    <section className="github">
      <div className="section-head">
        <h2>GitHub</h2>
      </div>
      {problem ? (
        <p className="muted">{problem}</p>
      ) : pr === undefined ? null : pr ? (
        <div className="pr">
          <span className={`pr-state ${pr.state.toLowerCase()}`}>{pr.isDraft ? "Draft" : titleCase(pr.state)}</span>
          <span className="pr-title">
            #{pr.number} {pr.title}
          </span>
          <button className="ghost-button small" onClick={() => openUrl(pr.url)}>
            Open on GitHub
          </button>
        </div>
      ) : status.upstream === null ? (
        <p className="muted">Publish the branch to open a pull request.</p>
      ) : (
        <form
          className="pr-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act("pr", "github_create_pull_request", { title, body, draft }, "Opened")) {
              setTitle("");
              setBody("");
              load();
            }
          }}
        >
          <input value={title} placeholder="Pull request title" aria-label="Pull request title" onChange={(e) => setTitle(e.target.value)} />
          <textarea rows={3} value={body} placeholder="Description (optional)" aria-label="Pull request description" onChange={(e) => setBody(e.target.value)} />
          <div className="pr-actions">
            <label>
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Draft
            </label>
            <button className="primary-button" type="submit" disabled={!title.trim() || busy !== null}>
              {busy === "pr" ? "Opening…" : "Open pull request"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function lineClass(line: string) {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta-line";
  if (line.startsWith("+")) return "add-line";
  if (line.startsWith("-")) return "del-line";
  if (line.startsWith("@@")) return "hunk-line";
  return "";
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function titleCase(word: string) {
  return word.charAt(0) + word.slice(1).toLowerCase();
}
