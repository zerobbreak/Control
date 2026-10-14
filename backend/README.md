# Mission Control Backend

The Rust runtime. It starts agents on goals and watches Claude Code and Gemini CLI sessions.

- `jev.rs` calls Jev, TypeSafe AI's hosted classifier, when a `TYPESAFE_API_KEY` user environment variable is set. It picks the agent with a confidence in well under a second; the model router acts on it at 0.9 confidence or above and asks Haiku otherwise. Only the goal and the names of handed-over folders and files are sent. Without a key it is never called.
- `model_router.rs` then asks a fast model (Haiku, through `claude --print` with no tools) which agent a goal is for, so personal goals such as "play J. Cole" reach the browser or the assistant and only software work reaches the coding agent. It names the task, tier and a reason; what each task may touch stays fixed. Answers are cached so a reviewed plan and its run agree, and if the model is unavailable or slow the keyword router decides.
- `router.rs` is that keyword router: what kind of task a goal is (code, question, browse, assistant), how strong a model it needs and what the run may touch. The folder you hand over is the mode: with a project it is work; without one, goals go to the browser or the assistant unless they clearly talk about code.
- `agent.rs` holds the `Agent` trait and two agents built on `claude --print`: `ClaudeCode` for code and questions about folders, and `ClaudeAssistant` for errands in apps and dropped files. The assistant can read files and use the claude.ai connectors (Notion, Gmail and so on) but cannot run commands or change files; reading in apps runs freely, anything that creates, changes or sends asks first. It waits for the connectors to connect before taking its goal.
- `orchestrator.rs` starts the agent, logs its output to `~/.mission-control/runs/<id>.log` and tracks the process until it exits.
- Approvals: agents run with Mission Control as their host on stdin and stdout (`--permission-prompt-tool stdio`). Anything the permission mode does not already allow arrives as a pending approval and waits until it is answered. Read-only runs are refused such requests automatically.
- `settings.rs` is Boundaries, saved to `~/.mission-control/settings.json`. It covers which agents may start, whether other sessions are watched, the strongest model allowed, a spending limit per run, commands allowed without asking, read-only mode, full autonomy and the folders runs may use. The orchestrator and watcher enforce every setting; defaults are the cautious choice.
- `git.rs` drives the installed `git` and `gh` CLIs for the user's own controls: status, diffs, stage, unstage, commit, push, pull, fetch, branches and pull requests. Existing credentials and SSH keys apply. It also classifies agents' shell commands, so Boundaries can rule on agents committing and pushing; "never" and protected branches outrank full autonomy.
- `watcher.rs` and `board.rs` tail agent transcripts. A run's ID is passed as the agent's `--session-id`, so the board shows a run's live progress under that same ID.

## Run

From the repository root:

```powershell
# Summarise recent sessions
cargo run -p backend

# Stream every event as JSON
cargo run -p backend -- --follow

# Route a goal, start an agent on it and follow it until it exits.
# Permission requests are asked on the terminal: answer y or n.
cargo run -p backend -- run "Which file in here is the largest?" --in C:\path\to\folder
cargo run -p backend -- run "Fix the typo in the README" --in C:\dev\some-project
cargo run -p backend -- run "Create a Notion page for this assignment" --attach C:\path\to\assignment.pdf
```

Without `--in`, the agent runs in `~/.mission-control/scratch`. Code work needs `--in`: it is refused without a project folder.

## Check

```powershell
cargo test -p backend
```
