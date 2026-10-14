import { describe, expect, it } from "vitest";
import { accessBadge, contextCounts, insertMention, mentionAt, mentionOptions, planSteps, splitContext } from "./context";
import type { App, ContextItem, Preview } from "./types";

const item = (name: string, kind: ContextItem["kind"], path = `C:/stuff/${name}`, project = false): ContextItem => ({
  path,
  name,
  kind,
  detail: "",
  project,
});

const lumina = item("Lumina", "folder", "C:/dev/Lumina", true);
const shot = item("login-error.png", "image");
const spec = item("auth-spec.pdf", "pdf");

function preview(over: Partial<Preview> & { task?: Preview["decision"]["task"]; access?: Preview["decision"]["access"] } = {}): Preview {
  const { task = "code", access = "editFiles", ...rest } = over;
  return {
    decision: { task, tier: "balanced", access, reason: "A typical code change." },
    workdir: "C:/dev/Lumina",
    model: "sonnet",
    askBeforeEdits: false,
    fullAutonomy: false,
    capability: null,
    capabilityGranted: null,
    ...rest,
  };
}

describe("splitContext", () => {
  it("runs in the first project and reads the rest", () => {
    const docs = item("docs", "folder");
    expect(splitContext([shot, lumina, docs, spec])).toEqual({
      folder: "C:/dev/Lumina",
      attachments: [shot.path, docs.path, spec.path],
    });
  });

  it("never runs in a loose folder such as Downloads", () => {
    const downloads = item("Downloads", "folder");
    expect(splitContext([downloads])).toEqual({ folder: null, attachments: [downloads.path] });
  });

  it("never makes a project of a link", () => {
    expect(splitContext([item("Memo 2021.pdf", "link")])).toEqual({ folder: null, attachments: ["C:/stuff/Memo 2021.pdf"] });
  });

  it("has no project without a folder, and leaves out what has gone", () => {
    expect(splitContext([shot, item("gone.txt", "missing")])).toEqual({ folder: null, attachments: [shot.path] });
  });
});

describe("contextCounts", () => {
  it("counts by kind in a steady order", () => {
    expect(contextCounts([spec, shot, lumina, item("b.png", "image")])).toEqual(["1 folder", "2 images", "1 PDF"]);
    expect(contextCounts([item("Memo 2021.pdf", "link")]), "a shortcut counts as a link, not a file").toEqual(["1 link"]);
    expect(contextCounts([])).toEqual([]);
  });
});

describe("mentions", () => {
  it("finds the @word at the caret", () => {
    expect(mentionAt("test it in @Ch", 14)).toEqual({ query: "Ch", start: 11 });
    expect(mentionAt("@", 1)).toEqual({ query: "", start: 0 });
    expect(mentionAt("mail me@home", 12)).toBeNull();
    expect(mentionAt("test it in @Chrome now", 22)).toBeNull();
  });

  it("swaps the @word for the chosen name", () => {
    expect(insertMention("test it in @Ch", 14, "Google Drive")).toEqual({ text: "test it in @GoogleDrive ", caret: 24 });
    expect(insertMention("@no then more", 3, "Notion")).toEqual({ text: "@Notion  then more", caret: 8 });
  });

  it("offers connected apps and handed-over files, best matches first", () => {
    const apps: App[] = [
      { name: "Notion", id: "claude_ai_Notion", status: "connected" },
      { name: "Google Drive", id: "claude_ai_Google_Drive", status: "connected" },
      { name: "Microsoft 365", id: "claude_ai_Microsoft_365", status: "needsAuth" },
    ];
    expect(mentionOptions("", apps, [spec]).map((m) => m.name)).toEqual(["Notion", "Google Drive", "auth-spec.pdf"]);
    expect(mentionOptions("dri", apps, []).map((m) => m.name)).toEqual(["Google Drive"]);
    expect(mentionOptions("micro", apps, []), "apps that need signing in are not offered").toEqual([]);
    expect(mentionOptions("o", apps, [spec]).map((m) => m.name)).toEqual(["Notion", "Google Drive"]);
  });
});

describe("plan", () => {
  it("lays out the router's decision, then reporting back", () => {
    const [work, report] = planSteps(preview(), [lumina, shot, spec]);
    expect(work).toMatchObject({
      agent: "Claude",
      where: "Lumina",
      title: "Make the change in Lumina",
      detail: "Reads login-error.png and auth-spec.pdf. A typical code change.",
      badge: { label: "Edits on its own", tone: "auto" },
    });
    expect(report.agent).toBe("Mission Control");
  });

  it("looks through a loose folder read-only", () => {
    const downloads = item("Downloads", "folder");
    const [work] = planSteps(preview({ task: "assistant", access: "readOnly", workdir: "C:/scratch" }), [downloads]);
    expect(work).toMatchObject({ where: "Downloads", title: "Look through Downloads", badge: { label: "Read only" } });
  });

  it("names the assistant for app work", () => {
    const [work] = planSteps(preview({ task: "assistant", access: "useApps", workdir: "C:/scratch" }), []);
    expect(work).toMatchObject({ agent: "Assistant", role: "assist", where: "Your apps" });
  });

  it("says what the run may do without asking", () => {
    expect(accessBadge(preview({ access: "readOnly", fullAutonomy: true })).label).toBe("Read only");
    expect(accessBadge(preview({ fullAutonomy: true })).label).toBe("Automatic");
    expect(accessBadge(preview({ askBeforeEdits: true })).label).toBe("Asks first");
    expect(accessBadge(preview({ access: "useApps" })).label).toBe("Asks before changes");
  });
});
