# Mission Control Backend

The Rust runtime. It starts agents on goals and watches Claude Code and Gemini CLI sessions.

- `router.rs` decides what kind of task a goal is (code, question, browse), how strong a model it needs and what the run may touch.
- `agent.rs` holds the `Agent` trait and `ClaudeCode`, which turns a routed goal into a `claude --print` command.
- `orchestrator.rs` starts the agent, logs its output to `~/.mission-control/runs/<id>.log` and tracks the process until it exits.
- `watcher.rs` and `board.rs` tail agent transcripts. A run's ID is passed as the agent's `--session-id`, so the board shows a run's live progress under that same ID.

## Run

From the repository root:

```powershell
# Summarise recent sessions
cargo run -p backend

# Stream every event as JSON
cargo run -p backend -- --follow

# Route a goal, start an agent on it and follow it until it exits
cargo run -p backend -- run "Which file in here is the largest?" --in C:\path\to\folder
cargo run -p backend -- run "Fix the typo in the README" --in C:\dev\some-project
```

Without `--in`, the agent runs in `~/.mission-control/scratch`.

## Check

```powershell
cargo test -p backend
```
