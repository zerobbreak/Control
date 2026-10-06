import { describe, expect, it } from "vitest";
import type { Settings } from "../types";
import { gitRulesSentence, joinOr, syncLabel } from "./summary";

describe("syncLabel", () => {
  const base = { upstream: "origin/main", ahead: 0, behind: 0, remotes: ["origin"] };
  it("describes where the branch stands against its upstream", () => {
    expect(syncLabel(base)).toBe("Up to date with origin/main");
    expect(syncLabel({ ...base, ahead: 2 })).toBe("2 ahead of origin/main");
    expect(syncLabel({ ...base, behind: 1 })).toBe("1 behind origin/main");
    expect(syncLabel({ ...base, ahead: 2, behind: 1 })).toBe("2 ahead, 1 behind origin/main");
  });
  it("says when there is nowhere to push", () => {
    expect(syncLabel({ ...base, upstream: null })).toBe("Not published yet");
    expect(syncLabel({ ...base, upstream: null, remotes: [] })).toBe("No remote yet");
  });
});

describe("gitRulesSentence", () => {
  const settings: Pick<Settings, "agentCommit" | "agentPush" | "protectedBranches" | "fullAutonomy"> = {
    agentCommit: "ask",
    agentPush: "never",
    protectedBranches: ["main", "master"],
    fullAutonomy: false,
  };

  it("states both rules and the protected branches", () => {
    expect(gitRulesSentence(settings, "fix/login")).toBe("Agents ask before committing and never push here. On main or master they always ask before committing.");
  });

  it("merges matching rules", () => {
    expect(gitRulesSentence({ ...settings, agentPush: "ask" }, "dev")).toBe(
      "Agents ask before committing or pushing here. On main or master they always ask before committing or pushing.",
    );
    expect(gitRulesSentence({ ...settings, agentCommit: "never" }, "dev")).toBe("Agents never commit or push here.");
  });

  it("lets full autonomy answer Ask, but not Never or a protected branch", () => {
    const full = { ...settings, fullAutonomy: true };
    expect(gitRulesSentence(full, "dev")).toBe("Agents commit on their own and never push here. On main or master they always ask before committing.");
    expect(gitRulesSentence({ ...full, agentPush: "allow" }, "main")).toBe("Agents ask before committing or pushing on main, a protected branch.");
  });

  it("leaves out the protected clause when there are none", () => {
    expect(gitRulesSentence({ ...settings, protectedBranches: [] }, null)).toBe("Agents ask before committing and never push here.");
  });
});

describe("joinOr", () => {
  it("joins like a sentence", () => {
    expect(joinOr(["main"])).toBe("main");
    expect(joinOr(["main", "master", "develop"])).toBe("main, master or develop");
  });
});
