# Mission Control

Product vision and north star: @VISION.md

Every feature should move toward *goal → orchestration → agents → observable work → result*. Mission Control is an agent runtime and orchestrator, not a chat app. It is local-first: the Rust runtime runs on the user's machine. Agents (Claude Code first, as the `CodingAgent`) sit behind abstractions so other implementations can be swapped in.
