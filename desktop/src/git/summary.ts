// Plain-language lines for the Changes screen: where the branch stands, and what agents may do here.

import type { GitRule, RepoStatus, Settings } from "../types";

/** "2 ahead of origin/main", "Up to date with origin/main", "Not published yet". */
export function syncLabel(status: Pick<RepoStatus, "upstream" | "ahead" | "behind" | "remotes">): string {
  if (status.remotes.length === 0) return "No remote yet";
  if (status.upstream === null) return "Not published yet";
  const parts = [status.ahead > 0 && `${status.ahead} ahead`, status.behind > 0 && `${status.behind} behind`].filter(Boolean);
  if (parts.length === 0) return `Up to date with ${status.upstream}`;
  // "2 ahead of origin", "1 behind origin", "2 ahead, 1 behind origin".
  return `${parts.join(", ")} ${status.behind > 0 ? "" : "of "}${status.upstream}`;
}

type Effective = "ask" | "allow" | "never";

const COMMIT: Record<Effective, string> = { ask: "ask before committing", allow: "commit on their own", never: "never commit" };
const PUSH: Record<Effective, string> = { ask: "ask before pushing", allow: "push on their own", never: "never push" };
const BOTH: Record<Effective, string> = { ask: "ask before committing or pushing", allow: "commit and push on their own", never: "never commit or push" };

/**
 * What the runtime will do when an agent commits or pushes on `branch`, mirroring auto_answer in
 * orchestrator.rs: Never always refuses, a protected branch always asks, and Ask gives way to full
 * autonomy.
 */
export function gitRulesSentence(settings: Pick<Settings, "agentCommit" | "agentPush" | "protectedBranches" | "fullAutonomy">, branch: string | null): string {
  const isProtected = branch !== null && settings.protectedBranches.includes(branch);
  const effective = (rule: GitRule): Effective =>
    rule === "never" ? "never" : isProtected ? "ask" : rule === "allow" || settings.fullAutonomy ? "allow" : "ask";
  const commit = effective(settings.agentCommit);
  const push = effective(settings.agentPush);
  const rules = commit === push ? BOTH[commit] : `${COMMIT[commit]} and ${PUSH[push]}`;

  if (isProtected) return `Agents ${rules} on ${branch}, a protected branch.`;

  const sentence = `Agents ${rules} here.`;
  const guarded = [settings.agentCommit !== "never" && "committing", settings.agentPush !== "never" && "pushing"].filter(Boolean);
  if (settings.protectedBranches.length === 0 || guarded.length === 0) return sentence;
  return `${sentence} On ${joinOr(settings.protectedBranches)} they always ask before ${guarded.join(" or ")}.`;
}

/** "main", "main or master", "main, master or develop". */
export function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
