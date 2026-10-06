// The three autonomy levels on Boundaries, stored as two runtime flags.

import type { AppAccess, Settings } from "../types";

export type Autonomy = "look" | "ask" | "full";

/** Read-only mode outranks full autonomy in the runtime, so it wins here too if both are set. */
export function autonomyOf(settings: Pick<Settings, "readOnlyMode" | "fullAutonomy">): Autonomy {
  if (settings.readOnlyMode) return "look";
  return settings.fullAutonomy ? "full" : "ask";
}

export function autonomyPatch(level: Autonomy): Pick<Settings, "readOnlyMode" | "fullAutonomy"> {
  return { readOnlyMode: level === "look", fullAutonomy: level === "full" };
}

/** Apps the user hasn't set are "ask", as in Settings::app_access. */
export function appAccessOf(settings: Pick<Settings, "appAccess">, id: string): AppAccess {
  return settings.appAccess[id] ?? "ask";
}

/** Adds an item to a chip list, ignoring blanks and duplicates. */
export function addItem(items: string[], item: string): string[] {
  const value = item.trim();
  return value === "" || items.includes(value) ? items : [...items, value];
}
