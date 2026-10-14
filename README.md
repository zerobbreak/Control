# Mission Control

**A local-first desktop AI agent platform. Give your computer goals instead of individual commands, and watch and control the agents that carry them out.**

Mission Control is an agent runtime and orchestrator, not a chat app. You hand it a goal (and optionally a project folder or some files), it decides which agent should do the work, runs that agent on your machine, and shows you what it is doing. Anything risky waits for your approval.

The flow it is built around is *goal → orchestration → agents → observable work → result*. See [VISION.md](VISION.md) for the full product vision.

## How it works

```text
Mission Control UI (Tauri + React: floating pill and main window)
        │
        ▼
Mission Control runtime (Rust, runs locally)
        │   route the goal → pick an agent → enforce Boundaries
        ▼
Agents (Claude Code first, behind an `Agent` abstraction)
        │
        ▼
Your projects, files, apps, terminal and git
```

1. **Route.** A goal is classified as code, a question, browsing or an assistant errand. Routing is layered: the Jev classifier (optional, hosted), then a fast Haiku model, then a keyword router as the fallback. The folder you hand over decides the mode: with a project it is work, without one the goal goes to the browser or the assistant unless it clearly talks about code.
2. **Run.** The orchestrator starts the chosen agent, logs its output and tracks the process until it exits.
3. **Observe.** A watcher tails agent transcripts, so progress shows up live in the pill and the board, including sessions you started yourself.
4. **Control.** Agents ask the runtime for permission. Anything that Boundaries do not already allow appears as a pending approval that waits for you.

## Features

- **Floating pill.** A small always-on-top, transparent window with an animated face that shows agent state (idle, thinking, coding, needs you, done). It expands into a card view and accepts dropped files and folders.
- **Main window.** A desk with a composer, today's runs, a per-run view with progress, a command centre, a changes panel (git status and diffs) and the assistant.
- **Model-aware routing.** Each task gets a task type, a model tier and a reason, so personal goals reach the assistant or browser and only software work reaches the coding agent.
- **Two agents built on `claude --print`.**
  - `ClaudeCode` works on code and answers questions about folders.
  - `ClaudeAssistant` runs errands in apps and on dropped files. It can read files and use the claude.ai connectors (Notion, Gmail and so on) but cannot run commands or change files. Reading in apps runs freely; anything that creates, changes or sends asks first.
- **Session watching.** Claude Code and Gemini CLI transcripts are normalised into one event stream.
- **Git controls.** Status, diffs, stage, unstage, commit, push, pull, fetch, branches and pull requests through your installed `git` and `gh`, using your existing credentials.
- **Media controls.** What is playing, plus play, pause, skip and volume, through Windows' own media controls (once you allow them).
- **Context for goals.** Dropped files and folders are described in the pill before anything reads them.

## Boundaries (autonomy within limits)

Boundaries live in `~/.mission-control/settings.json` and are enforced by both the orchestrator and the watcher. Defaults are the cautious choice. They cover:

- which agents may start, and whether other sessions are watched
- the strongest model allowed and a spending limit per run
- commands allowed without asking
- read-only mode and full autonomy
- the folders runs may use
- per-app access for connectors (read only, ask before changes, and so on)
- whether agents may commit and push. "Never" and protected branches outrank full autonomy.

Read-only runs refuse permission requests automatically.

## Project layout

| Path | What it is |
| --- | --- |
| `backend/` | Rust runtime crate (`mission_control` library plus a `backend` CLI). See [backend/README.md](backend/README.md) for module details. |
| `desktop/` | Tauri 2 desktop app with a React 19 + TypeScript frontend (Vite, Vitest). |
| `desktop/src-tauri/` | Rust side of the Tauri app, which exposes the runtime to the UI. |
| `docs/research/` | Research notes, such as the Jev classifier. |
| `VISION.md` | Product vision and north star. |

Backend modules at a glance: `router`, `model_router`, `jev` (routing), `agent`, `orchestrator` (running), `watcher`, `board`, `claude`, `gemini`, `events` (observing), `settings`, `apps`, `git` (control), `context`, `media`.

## Requirements

- Windows 11 (the media controls use Windows APIs; the app is developed there)
- [Rust](https://rustup.rs/) (edition 2024, so a recent stable toolchain)
- [Node.js](https://nodejs.org/) and npm
- The [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/), including WebView2
- [Claude Code](https://claude.com/claude-code) (`claude`) on your `PATH`, signed in. It is the first agent.
- Optional: `git` and `gh` for the git controls, the Gemini CLI to watch Gemini sessions, and a `TYPESAFE_API_KEY` user environment variable to enable the Jev classifier. Without a key Jev is never called.

## Getting started

Install the frontend dependencies once:

```powershell
cd desktop
npm install
```

Start the desktop app in development:

```powershell
npm run tauri dev
```

Build the frontend only:

```powershell
npm run build
```

## Using the CLI

The backend also runs without the UI, from the repository root:

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

Without `--in`, the agent runs in `~/.mission-control/scratch`. Code work needs `--in` and is refused without a project folder.

## Development

```powershell
# Check all Rust workspace crates
cargo check

# Backend tests
cargo test -p backend

# Frontend tests
cd desktop
npm test
```

## Data on disk

Everything stays on your machine under `~/.mission-control/`:

- `settings.json`: your Boundaries
- `runs/<id>.log`: output of each run
- `scratch/`: working folder for runs without a project

Only if you set `TYPESAFE_API_KEY` is anything sent off the machine to Mission Control's own routing: the goal text and the names of handed-over folders and files go to Jev. The agents themselves talk to their own providers as usual.

## Roadmap

Claude Code is the first implementation of `CodingAgent`. Next come browser and desktop agents, then further coding agents behind the same abstraction, and drag-out of results onto the desktop.
