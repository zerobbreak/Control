// Temporary harness: renders the real Pill in a browser with Tauri mocked out.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import React from "react";
import ReactDOM from "react-dom/client";
import type { BoardSnapshot, SessionSummary } from "./types";

const now = new Date().toISOString();
const s = (id: string, status: SessionSummary["status"], currentActivity: string | null, agent: "claude" | "gemini" = "claude"): SessionSummary => ({
  agent, sessionId: id, project: "C:/dev/" + id, title: null, status, startedAt: now, lastActivity: now,
  lastPrompt: "Fix login", currentActivity, lastMessage: null, toolCalls: 3, toolErrors: 0,
});
const scenario = new URLSearchParams(location.search).get("s") ?? "mixed";
const boards: Record<string, SessionSummary[]> = {
  idle: [],
  mixed: [s("lumina", "working", "Edit · auth/session.rs"), s("devpulse", "working", "Thinking", "gemini"), s("notes", "waitingForUser", null)],
  needs: [s("lumina", "stalled", "Bash · npm install @auth/core"), s("devpulse", "working", "Edit · a.rs")],
  done: [s("lumina", "waitingForUser", null)],
};
const board: BoardSnapshot = { sessions: boards[scenario], feed: [] };

mockWindows("pill");
mockIPC((cmd) => {
  if (cmd === "board_snapshot") return board;
  if (cmd === "plugin:event|listen") return 1;
  return null;
});
(window as any).__resize = [];
const { default: Pill } = await import("./Pill");
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><Pill /></React.StrictMode>);
