// The island's face: two eyes, with the lead agent's state between them.

import type { AvatarRole, AvatarState } from "./avatar/blob";

export type FaceState = AvatarState | "failed";

/** An agent's colour: its eyes take a gradient, so the same face reads as Claude, Gemini and so on. */
export type Tint = "claude" | "gemini" | "browser" | "assistant";

/** What sits between the eyes for each state; a working face shows its agent's glyph. */
export function Face({ state, role = "code", small = false, large = false, tint }: { state: FaceState; role?: AvatarRole; small?: boolean; large?: boolean; tint?: Tint }) {
  return (
    <span className={`mc-face ${state}${small ? " small" : ""}${large ? " large" : ""}${tint ? ` tint-${tint}` : ""}`} aria-hidden="true">
      <span className="mc-eye" />
      {state === "thinking" && (
        <span className="mc-dots">
          <span />
          <span />
          <span />
        </span>
      )}
      {state === "working" && <RoleGlyph role={role} />}
      {state === "needs" && <span className="mc-glyph" style={{ color: "var(--needs)", fontSize: 13 }}>!</span>}
      {state === "done" && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--done)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <path className="mc-check" pathLength="1" d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      )}
      {state === "failed" && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--failed)" strokeWidth="3.5" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      )}
      <span className="mc-eye" />
    </span>
  );
}

/** Each agent's mark: </> for code, a globe for the browser, a spark for the assistant. */
export function RoleGlyph({ role, color = "var(--working)", size = 11 }: { role: AvatarRole; color?: string; size?: number }) {
  if (role === "code") return <span className="mc-glyph" style={{ color, fontSize: size }}>{"</>"}</span>;
  const path =
    role === "web"
      ? "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"
      : role === "assist"
        ? "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"
        : "M12 8a4 4 0 100 8 4 4 0 000-8z";
  return (
    <svg width={size + 1} height={size + 1} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}
