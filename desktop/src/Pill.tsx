import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { open as pickPaths } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import { BlobAvatar } from "./avatar/BlobAvatar";
import { Icon } from "./Icon";
import { AppsView, Composer, ComposeView, ReviewView } from "./ContextViews";
import { NowPlayingCard, NowPlayingFace, RecycleSuggestion, RoutingCard } from "./Assistant";
import { CAPABILITIES, recycleSuggestions } from "./capabilities";
import { contextCounts, splitContext } from "./context";
import { mostUrgent, progressSteps, STATE_LABEL } from "./avatar/pillState";
import {
  agentActivity,
  agentCards,
  ago,
  cardSessionId,
  connectionLabel,
  detailMeta,
  elapsed,
  fileName,
  firstLink,
  linkLabel,
  pillCards,
  requestVerb,
  resultHeadline,
  roughlyAgo,
  sessionView,
  statusCounts,
  tileLine,
  unansweredCall,
  type AgentCard,
} from "./runs";
import type {
  AgentEvent,
  App,
  AppAccess,
  BoardSnapshot,
  Capability,
  ContextItem,
  MediaAction,
  NowPlaying,
  PendingApproval,
  Preview,
  RunSummary,
  Settings,
} from "./types";
import "./Pill.css";

const COLLAPSED = { width: 240, height: 72 };
// Wide enough for Mission Control on the left and a 2 × 2 grid of agents beside it.
const EXPANDED = { width: 760, height: 320 };
// One agent opened up is a single column; its height follows what it has to show.
const DETAIL_WIDTH = 480;
// The window is this much bigger than the island: the stage's top padding and room for the shadow.
const WINDOW_MARGIN = 16;
const GRID_SLOTS = 4;
// Matches the --morph transition in Pill.css, so the window shrinks only after the pill has.
const MORPH_MS = 320;

/** Subscribes to a backend event, seeded from a snapshot command so it is filled straight away. */
function useBackend<T>(command: string, event: string, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    invoke<T>(command).then(setValue);
    const unlisten = listen<T>(event, (e) => setValue(e.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [command, event]);
  return value;
}

/** The current time, ticking once a second while `live`, for elapsed times on cards. */
function useNow(live: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * Where the cursor is, in page coordinates, so Mission Control can watch it. The pill only hears
 * pointer events over its own window, so while open it also polls the desktop cursor position.
 */
function useCursor(live: boolean) {
  const point = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!live) return;
    const win = getCurrentWindow();
    let stopped = false;
    const onMove = (e: PointerEvent) => {
      point.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", onMove);
    (async () => {
      let origin = await win.innerPosition();
      let scale = await win.scaleFactor();
      for (let tick = 0; !stopped; tick++) {
        // The window rarely moves, so its position is only re-read every second or so.
        if (tick % 20 === 0) [origin, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
        const cursor = await cursorPosition();
        point.current = { x: (cursor.x - origin.x) / scale, y: (cursor.y - origin.y) / scale };
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    })().catch(() => {
      // No desktop cursor: the eyes still follow the pointer over the pill itself.
    });
    return () => {
      stopped = true;
      window.removeEventListener("pointermove", onMove);
    };
  }, [live]);
  return point;
}

/** Mission Control's one-line mood under its name. */
function heroLine(counts: { needs: number; working: number; done: number }) {
  if (counts.needs > 0) return counts.needs === 1 ? "An agent needs you" : `${counts.needs} agents need you`;
  if (counts.working > 0) return counts.working === 1 ? "One agent at work" : `${counts.working} agents at work`;
  if (counts.done > 0) return "All done";
  return "Ready for a goal";
}

/**
 * What is playing, kept fresh by the runtime while media controls are allowed. Before that the
 * pill never asks.
 */
function useMedia(allowed: boolean): NowPlaying | null {
  const [media, setMedia] = useState<NowPlaying | null>(null);
  useEffect(() => {
    if (!allowed) {
      setMedia(null);
      return;
    }
    invoke<NowPlaying | null>("media_now").then(setMedia, () => setMedia(null));
    const unlisten = listen<NowPlaying | null>("media-updated", (e) => setMedia(e.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [allowed]);
  return media;
}

/** The right-hand side of the open pill: the agents, or one step of starting a mission. */
type View = "agents" | "compose" | "review" | "apps";

export default function Pill() {
  const board = useBackend<BoardSnapshot>("board_snapshot", "board-updated", { sessions: [], feed: [] });
  const runs = useBackend<RunSummary[]>("runs_snapshot", "runs-updated", []);
  const approvals = useBackend<PendingApproval[]>("approvals_snapshot", "approvals-updated", []);
  const [expanded, setExpanded] = useState(false);
  // The agent opened for details, by card key; null shows the whole stack.
  const [focus, setFocus] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  // Files and folders handed over for the next goal; the first folder is the project it runs in.
  const [context, setContext] = useState<ContextItem[]>([]);
  const [dropping, setDropping] = useState<ContextItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [view, setView] = useState<View>("agents");
  // Where the apps view goes back to.
  const [appsFrom, setAppsFrom] = useState<View>("agents");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [apps, setApps] = useState<App[] | null>(null);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState<string | null>(null);
  const settings = useBackend<Settings | null>("get_settings", "settings-updated", null);
  const media = useMedia(settings?.capabilities.mediaControls === true);
  const collapseTimer = useRef<number>(undefined);
  // A native file picker takes focus from the pill; that must not tuck it away.
  const picking = useRef(false);
  const now = useNow(expanded);
  const cursor = useCursor(expanded);
  const pill = useRef<HTMLDivElement>(null);

  async function expand() {
    window.clearTimeout(collapseTimer.current);
    await invoke("set_pill_size", EXPANDED);
    setExpanded(true);
  }

  function collapse() {
    setExpanded(false);
    setFocus(null);
    collapseTimer.current = window.setTimeout(() => invoke("set_pill_size", COLLAPSED), MORPH_MS);
  }

  // Clicking anywhere else on the desktop tucks the pill away again.
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused && !picking.current) collapse();
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  // Files and folders dragged onto the pill become attachments for the next goal.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter") {
        setDropping([]);
        expand();
        describe(payload.paths).then((items) => setDropping((d) => (d ? items : d)));
      } else if (payload.type === "drop") {
        setDropping(null);
        attach(payload.paths);
      } else if (payload.type === "leave") {
        setDropping(null);
      }
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  const watched = board.sessions.filter((s) => s.status !== "idle");
  const cards = pillCards(agentCards(runs, watched, approvals, sessionView), now);
  const counts = statusCounts(cards);
  const lead = mostUrgent(cards.map((c) => c.state));
  const crew = cards.filter((c) => c.active || c.state === "done").slice(0, 3);
  // An agent that drops out of the stack while open sends you back to the list.
  const focused = cards.find((c) => c.key === focus) ?? null;
  // Media controls are asked about once the browser agent has started something.
  const askMedia =
    settings !== null &&
    settings.capabilities.mediaControls === undefined &&
    runs.some((r) => r.decision.task === "browse" && r.status === "finished");
  // An opened agent and the steps of starting a mission are one column sized to their content.
  const detail = expanded && (focused !== null || view !== "agents");
  const { folder, attachments } = splitContext(context);

  // The detail column sizes to its content, so the window follows the island's height. Back on
  // the grid (or if the opened agent drops out of the stack) the window returns to grid size.
  useEffect(() => {
    const island = pill.current;
    if (!expanded || !island) return;
    if (!detail) {
      invoke("set_pill_size", EXPANDED);
      return;
    }
    let height = 0;
    const fit = () => {
      const next = Math.ceil(island.getBoundingClientRect().height) + WINDOW_MARGIN;
      if (next === height) return;
      height = next;
      invoke("set_pill_size", { width: DETAIL_WIDTH, height });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(island);
    fit();
    return () => observer.disconnect();
  }, [expanded, detail]);

  // Which apps are connected takes Claude Code a few seconds to check, so it is asked once, early.
  useEffect(() => {
    if (expanded && apps === null && !appsLoading) loadApps();
  }, [expanded]);

  async function loadApps() {
    setAppsLoading(true);
    setAppsError(null);
    try {
      setApps(await invoke<App[]>("list_apps"));
    } catch (err) {
      setAppsError(String(err));
    } finally {
      setAppsLoading(false);
    }
  }

  async function setAppAccess(app: App, level: AppAccess) {
    if (!settings) return;
    const next = { ...settings, appAccess: { ...settings.appAccess, [app.id]: level } };
    try {
      await invoke<Settings>("update_settings", { settings: next });
    } catch (err) {
      setAppsError(String(err));
    }
  }

  /** Saves the user's answer for a capability; the runtime enforces it from then on. */
  async function setCapability(capability: Capability, allowed: boolean) {
    if (!settings) return;
    const next = { ...settings, capabilities: { ...settings.capabilities, [capability]: allowed } };
    try {
      await invoke<Settings>("update_settings", { settings: next });
      // A preview carries the answer it was made with, so it is made again.
      if (view === "review" && preview?.capability === capability) {
        setPreview(await invoke<Preview>("preview_task", { prompt, folder, attachments }));
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function controlMedia(action: MediaAction) {
    try {
      await invoke("media_control", { action });
    } catch (err) {
      setError(String(err));
    }
  }

  function describe(paths: string[]) {
    return invoke<ContextItem[]>("describe_paths", { paths });
  }

  /** Adds files and folders as context for the next goal and opens a new mission around them. */
  async function attach(paths: string[]) {
    const items = await describe(paths);
    setContext((current) => [...current, ...items.filter((i) => !current.some((c) => c.path === i.path))]);
    setFocus(null);
    setView("compose");
  }

  function openApps() {
    if (view !== "apps") setAppsFrom(view);
    setView("apps");
    if (!apps && !appsLoading) loadApps();
  }

  /** The + button's alternative to dragging: pick files or a folder with the system dialog. */
  async function browse(directory: boolean) {
    picking.current = true;
    try {
      const picked = await pickPaths({ directory, multiple: true, title: directory ? "Add a folder" : "Add files" });
      if (picked) attach(Array.isArray(picked) ? picked : [picked]);
    } finally {
      picking.current = false;
    }
  }

  /** Shows what the goal would start, for review, before anything runs. */
  async function review() {
    if (!prompt.trim() || reviewing) return;
    setReviewing(true);
    setError(null);
    try {
      setPreview(await invoke<Preview>("preview_task", { prompt, folder, attachments }));
      setFocus(null);
      setView("review");
    } catch (err) {
      setError(String(err));
    } finally {
      setReviewing(false);
    }
  }

  async function start() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      await invoke<RunSummary>("start_task", { prompt, folder, attachments });
      setPrompt("");
      setContext([]);
      setPreview(null);
      setView("agents");
    } catch (err) {
      setError(String(err));
    } finally {
      setStarting(false);
    }
  }

  /** Escape steps back one level before it tucks the pill away. */
  function back() {
    if (focused) setFocus(null);
    else if (view === "apps") setView(appsFrom);
    else if (view === "review") setView(context.length > 0 ? "compose" : "agents");
    else if (view === "compose") setView("agents");
    else collapse();
  }

  const composer = (roomy: boolean) => (
    <Composer
      prompt={prompt}
      onPrompt={setPrompt}
      onSubmit={review}
      apps={apps ?? []}
      context={context}
      busy={reviewing}
      onBrowse={browse}
      roomy={roomy}
      placeholder={context.length > 0 ? "What should happen with these?" : "Type a goal, or drop a file or folder"}
    />
  );

  return (
    <div className="stage">
      <div
        ref={pill}
        className={`pill ${lead} ${expanded ? "expanded" : ""} ${detail ? "detail" : ""} ${dropping ? "dropping" : ""}`}
        onClick={expanded ? undefined : expand}
        onKeyDown={(e) => e.key === "Escape" && back()}
        role={expanded ? undefined : "button"}
        aria-label={expanded ? undefined : `Mission Control: ${STATE_LABEL[lead]}`}
      >
        <div className="pill-face">
          <BlobAvatar role="mc" state={lead} size={30} />
          {crew.length > 0 && (
            <span className="crew">
              {crew.map((c) => (
                <BlobAvatar key={c.key} role={c.role} state={c.state} size={18} />
              ))}
            </span>
          )}
          {media && <NowPlayingFace media={media} />}
        </div>

        {expanded && (
          <div className="panel">
            <aside className="panel-hero" hidden={detail}>
              <BlobAvatar role="mc" state={lead} size={media ? 52 : 84} lookAt={cursor} title={`Mission Control: ${STATE_LABEL[lead]}`} />
              <div className="hero-text">
                <strong>Mission Control</strong>
                <span className={`hero-line ${lead}`}>{heroLine(counts)}</span>
              </div>
              {!media && counts.needs + counts.working + counts.done > 0 && (
                <div className="status-chips">
                  {counts.needs > 0 && <span className="status-chip needs">{counts.needs} needs you</span>}
                  {counts.working > 0 && <span className="status-chip working">{counts.working} working</span>}
                  {counts.done > 0 && <span className="status-chip done">{counts.done} done</span>}
                </div>
              )}
              {media && <NowPlayingCard media={media} onControl={controlMedia} />}
              <footer className="panel-foot">
                <button className="link" onClick={() => invoke("quit_app")}>
                  Quit
                </button>
              </footer>
            </aside>

            <div className="panel-main">
              {focused ? (
                <AgentDetail
                  card={focused}
                  cards={cards}
                  board={board}
                  now={now}
                  onOpen={setFocus}
                  onBack={() => setFocus(null)}
                  onCollapse={collapse}
                  recycleAllowed={settings?.capabilities.recycleFiles ?? null}
                  onCapability={setCapability}
                  notionParent={settings?.notionParent ?? null}
                  readAppsFreely={settings?.readAppsFreely ?? true}
                  onFollowUp={setPrompt}
                />
              ) : view === "compose" ? (
                <ComposeView
                  context={context}
                  project={folder}
                  onRemove={(path) => setContext(context.filter((c) => c.path !== path))}
                  onClear={() => setContext([])}
                  onBack={() => setView("agents")}
                  onApps={openApps}
                  composer={composer(true)}
                />
              ) : view === "review" && preview?.decision.task === "browse" ? (
                <RoutingCard
                  goal={prompt}
                  preview={preview}
                  starting={starting}
                  onCapability={setCapability}
                  onCancel={() => setView(context.length > 0 ? "compose" : "agents")}
                  onGo={start}
                />
              ) : view === "review" && preview ? (
                <ReviewView
                  goal={prompt}
                  preview={preview}
                  context={context}
                  starting={starting}
                  onEdit={() => setView(context.length > 0 ? "compose" : "agents")}
                  onStart={start}
                  onAccess={openApps}
                />
              ) : view === "apps" ? (
                <AppsView
                  apps={apps}
                  loading={appsLoading}
                  error={appsError}
                  access={settings?.appAccess ?? {}}
                  onAccess={setAppAccess}
                  onRefresh={loadApps}
                  onBack={() => setView(appsFrom)}
                />
              ) : (
                <>
                  <header className="grid-head">
                    <strong>Agents</strong>
                    <span className="grid-count">{cards.length > 0 ? cards.length : ""}</span>
                    <span className="spacer" />
                    <button className="icon-button" onClick={openApps} aria-label="Apps and access">
                      <Icon name="shield" />
                    </button>
                    <button className="icon-button" onClick={() => invoke("open_dashboard")} aria-label="Open dashboard">
                      <Icon name="open" />
                    </button>
                    <button className="icon-button" onClick={collapse} aria-label="Collapse">
                      <Icon name="collapse" />
                    </button>
                  </header>

                  <div className="agent-grid">
                    {cards.map((card) => (
                      <AgentTile key={card.key} card={card} feed={board.feed} now={now} onOpen={() => setFocus(card.key)} />
                    ))}
                    {Array.from({ length: Math.max(0, GRID_SLOTS - cards.length) }, (_, i) => (
                      <div key={`slot-${i}`} className="tile slot">
                        {cards.length === 0 && i === 0 && <span>Nothing running. Type a goal below, or drop a file or folder here.</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {error && (
                <div className="pill-error" role="alert">
                  {error}
                  <button aria-label="Dismiss" onClick={() => setError(null)}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
              )}

              {(view === "agents" || focused) && (
                <>
                  {askMedia && (
                    <div className="media-ask">
                      <Icon name="play" size={13} />
                      <span title={CAPABILITIES.mediaControls.does.join(". ")}>{CAPABILITIES.mediaControls.ask}</span>
                      <span className="spacer" />
                      <button className="text-button" onClick={() => setCapability("mediaControls", false)}>
                        Don't allow
                      </button>
                      <button className="text-button link-blue" onClick={() => setCapability("mediaControls", true)}>
                        Allow
                      </button>
                    </div>
                  )}
                  {context.length > 0 && (
                    <button
                      className="context-strip"
                      onClick={() => {
                        setFocus(null);
                        setView("compose");
                      }}
                    >
                      <Icon name="file" size={13} />
                      {contextCounts(context).join(" · ")} in context
                      <span className="spacer" />
                      Open mission
                    </button>
                  )}
                  {composer(false)}
                </>
              )}
            </div>

            {dropping && (
              <div className="drop-target" aria-hidden="true">
                <BlobAvatar role="mc" state="thinking" size={64} lookAt={cursor} />
                <strong>Drop to add as context</strong>
                <span>Files, folders and screenshots stay on this computer. Mission Control reads only what you drop.</span>
                {dropping.length > 0 && (
                  <span className="drop-counts">
                    {contextCounts(dropping).map((count) => (
                      <span key={count} className="drop-count">
                        {count}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One agent in the grid: who it is on the first line; its state and what it did or is doing on
 * the second. The whole tile opens the agent's details; a request Mission Control can answer gets
 * Deny and Allow at the end of the second line.
 */
function AgentTile({ card, feed, now, onOpen }: { card: AgentCard; feed: AgentEvent[]; now: number; onOpen: () => void }) {
  const status = card.run?.status;
  const ended = status === "failed" || status === "cancelled";
  const label = ended ? (status === "cancelled" ? "Cancelled" : "Didn't finish") : STATE_LABEL[card.state];
  const line = tileLine(card, feed);
  const when = card.run?.endedAt ? roughlyAgo(card.run.endedAt, now) : elapsed(card.since, now);
  return (
    <article className={`tile ${ended ? "failed" : card.state}`} title={line}>
      <button className="tile-open" onClick={onOpen} aria-label={`${card.name}, ${label}: ${line}. Show details`} />
      <span className="tile-top" aria-hidden="true">
        <BlobAvatar role={card.role} state={card.state} size={24} />
        <span className="tile-name">
          <strong>{card.name}</strong>
          {card.place && <span className="place">{card.place}</span>}
        </span>
        <span className="card-time">{when}</span>
      </span>
      <div className="tile-status">
        <span className={`state-chip ${ended ? "failed" : card.state}`} aria-hidden="true">
          {label}
        </span>
        <span className="tile-line" aria-hidden="true">
          {line}
        </span>
        {card.approvals.length > 0 && <AnswerButtons approvals={card.approvals} small />}
      </div>
    </article>
  );
}

/** Deny and Allow for the oldest waiting request, answered through Mission Control. */
function AnswerButtons({ approvals, small = false }: { approvals: PendingApproval[]; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const request = approvals[0];

  async function answer(allow: boolean) {
    setBusy(true);
    try {
      await invoke("answer_approval", { runId: request.runId, requestId: request.requestId, allow });
    } finally {
      setBusy(false);
    }
  }

  const what = `${requestVerb(request.tool, request.label).toLowerCase()} ${request.detail}`;
  return (
    <div className={`answer ${small ? "small" : ""}`}>
      {!small && approvals.length > 1 && <span className="more">+{approvals.length - 1} more after this</span>}
      <button className="deny" disabled={busy} onClick={() => answer(false)} aria-label={small ? `Deny: ${what}` : undefined}>
        Deny
      </button>
      <button className="allow" disabled={busy} onClick={() => answer(true)} aria-label={small ? `Allow: ${what}` : undefined}>
        Allow
      </button>
    </div>
  );
}

/**
 * What an agent that needs you is asking for: "Wants to run" and the command, with Deny and Allow.
 * Shown in the detail view; the grid tile carries just the buttons.
 *
 * A run Mission Control started asks through Mission Control, so it can be answered here. A session
 * in your own terminal asks in that terminal; Mission Control can only show what it is held on.
 */
type PermissionProps = { card: AgentCard; feed: AgentEvent[]; notionParent: string | null; readAppsFreely: boolean };

function PermissionRequest({ card, feed, notionParent, readAppsFreely }: PermissionProps) {
  const request = card.approvals[0];

  if (!request) {
    const held = unansweredCall(feed, cardSessionId(card));
    return (
      <div className="permission">
        <span className="permission-verb">{held ? requestVerb(held.tool, held.tool) : "Waiting for your answer"}</span>
        {held && (
          <span className="permission-command">
            <Icon name="prompt" size={14} />
            {held.summary}
          </span>
        )}
        <span className="permission-elsewhere">
          <Icon name="terminal" size={14} />
          This session runs in your own terminal. Answer it there.
        </span>
      </div>
    );
  }

  // A request in a connected app names the app and what it would make, such as a page's title.
  if (request.tool.startsWith("mcp__")) {
    const newNotionPage = request.label.startsWith("Notion · create");
    return (
      <div className="permission app">
        <span className="permission-verb">
          <strong>{card.name}</strong> wants to
        </span>
        <div className="permission-app">
          <span className="permission-app-tool">{request.label}</span>
          <strong className="permission-app-detail">{request.detail ? `“${request.detail}”` : request.label}</strong>
          {newNotionPage && (
            <span className="permission-app-where">{notionParent ? `Goes under ${notionParent}` : "Private, in your workspace · no default location set"}</span>
          )}
        </div>
        <div className="permission-app-foot">
          {newNotionPage && (
            <button className="text-button link-blue" onClick={() => invoke("open_dashboard", { view: "command" })}>
              Set where pages go
            </button>
          )}
          <AnswerButtons approvals={card.approvals} />
        </div>
        <span className="permission-rule">
          <Icon name="shield" size={13} />
          {readAppsFreely ? "Creating, changing or sending always asks. Reading runs freely." : "Every request in your apps asks, reading too."}
        </span>
      </div>
    );
  }

  return (
    <div className="permission">
      <span className="permission-verb">{requestVerb(request.tool, request.label)}</span>
      <span className="permission-command">
        <Icon name="prompt" size={14} />
        {request.detail}
      </span>
      {request.description && <span className="permission-why">{request.description}</span>}
      <AnswerButtons approvals={card.approvals} />
    </div>
  );
}

/** While an assistant starts, each of its app connections, and that the goal waits for them. */
function Connecting({ connections }: { connections: { name: string; status: string }[] }) {
  return (
    <section className="detail-section connecting">
      <h3>
        Connecting
        <span className="live-note">waits up to 20s</span>
      </h3>
      {connections.length > 0 ? (
        <ul className="connections">
          {connections.map((c) => {
            const state = connectionLabel(c.status);
            return (
              <li key={c.name}>
                <span className="app-letter">{c.name.charAt(0)}</span>
                <span className="connection-name">{c.name}</span>
                <span className={`connection-state ${state.tone}`}>{state.label}</span>
                {state.note && <span className="connection-note">{state.note}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="detail-empty">Asking which apps are connected…</p>
      )}
      <p className="view-note">The goal is sent once every app has connected or given up.</p>
    </section>
  );
}

type DetailProps = {
  card: AgentCard;
  cards: AgentCard[];
  board: BoardSnapshot;
  now: number;
  onOpen: (key: string) => void;
  onBack: () => void;
  onCollapse: () => void;
  /** The user's answer for recycling suggested files, or null if not asked yet. */
  recycleAllowed: boolean | null;
  onCapability: (capability: Capability, allowed: boolean) => void;
  notionParent: string | null;
  readAppsFreely: boolean;
  /** Puts a follow-up goal in the box, such as moving a page the assistant made. */
  onFollowUp: (goal: string) => void;
};

/**
 * One agent opened up: where it is in its turn, what it needs from you or what it produced, and
 * the tool calls it has made. The other agents stay a click away in the switcher.
 */
function AgentDetail(props: DetailProps) {
  const { card, cards, board, now, onOpen, onBack, onCollapse, recycleAllowed, onCapability, notionParent, readAppsFreely, onFollowUp } = props;
  const run = card.run;
  const sessionId = cardSessionId(card);
  const session = card.session ?? board.sessions.find((s) => s.sessionId === sessionId);
  const activity = agentActivity(board.feed, sessionId);
  const ended = run?.status === "failed" || run?.status === "cancelled";
  const link = run?.status === "finished" ? firstLink(run.result) : null;
  const answer = run ? (run.status === "finished" ? run.result : null) : card.state === "done" ? session?.lastMessage : null;
  // Files the assistant suggests removing come in a block of their own, offered below the answer.
  const { text: result, paths: suggested } = recycleSuggestions(answer ?? null);
  const chip = ended ? (run?.status === "cancelled" ? "Cancelled" : "Didn't finish") : STATE_LABEL[card.state];
  const made = link ? resultHeadline(link, notionParent) : null;
  const access = run ? { readOnly: "Read only", editFiles: "Edits files", useApps: "Uses apps" }[run.decision.access] : null;

  return (
    <div className={`agent-detail ${card.state}`}>
      <header className="detail-head">
        <button className="back" onClick={onBack}>
          <Icon name="back" />
          Agents
        </button>
        <span className="spacer" />
        {cards.length > 1 && (
          <nav className="switcher" aria-label="Switch agent">
            {cards.map((c) => (
              <button
                key={c.key}
                aria-label={`${c.name}, ${STATE_LABEL[c.state]}`}
                aria-current={c.key === card.key ? "page" : undefined}
                title={`${c.name} · ${STATE_LABEL[c.state]}`}
                onClick={() => onOpen(c.key)}
              >
                <BlobAvatar role={c.role} state={c.state} size={24} />
              </button>
            ))}
          </nav>
        )}
        <button className="icon-button" onClick={onCollapse} aria-label="Collapse">
          <Icon name="collapse" />
        </button>
      </header>

      <div className="detail-body">
        <div className="detail-hero">
          <BlobAvatar role={card.role} state={card.state} size={44} />
          <div className="detail-title">
            <div>
              <strong>{card.name}</strong>
              <span className={`state-chip ${ended ? "failed" : card.state}`}>{chip}</span>
            </div>
            <span className="detail-meta">{detailMeta(card, now, session?.toolCalls ?? 0, session?.toolErrors ?? 0)}</span>
            {run && (
              <span className="detail-chips">
                <span className="model-chip">{run.model}</span>
                {access && <span className="chip">{access}</span>}
              </span>
            )}
          </div>
        </div>

        {made && (
          <div className="made">
            <span className="made-check">
              <Icon name="check" size={18} />
            </span>
            <div>
              <strong>{made.title}</strong>
              <span>{made.note}</span>
            </div>
          </div>
        )}

        {run && (
          <p className="detail-goal" title={run.goal}>
            {run.goal}
          </p>
        )}

        {run && run.attachments.length > 0 && (
          <div className="context-chips">
            {run.attachments.map((path) => (
              <span key={path} className="context-chip" title={path}>
                <Icon name="file" size={11} />
                {fileName(path)}
              </span>
            ))}
          </div>
        )}

        {!ended && (
          <ol className="tracker" aria-label="Progress">
            {progressSteps(card.state).map((step) => (
              <li key={step.label} className={step.status} aria-current={step.status === "current" ? "step" : undefined}>
                <span className="dot" />
                {step.label}
              </li>
            ))}
          </ol>
        )}

        {card.state === "needs" && (
          <section className="detail-request" aria-label={`${card.name} needs your OK`}>
            <PermissionRequest card={card} feed={board.feed} notionParent={notionParent} readAppsFreely={readAppsFreely} />
          </section>
        )}

        {run?.status === "starting" && (
          <>
            <p className="detail-note">{run.decision.reason}</p>
            {run.decision.task === "assistant" && <Connecting connections={run.connections} />}
          </>
        )}

        {ended && run && (
          <p className="detail-note failed">
            {run.status === "cancelled"
              ? "You stopped this run."
              : `It didn't finish${run.exitCode !== null ? ` (exit code ${run.exitCode})` : ""}. The log has what happened.`}
          </p>
        )}

        {result && (
          <section className="detail-section">
            <h3>Result</h3>
            <div className="detail-result">{result}</div>
          </section>
        )}

        {run && suggested.length > 0 && (
          <RecycleSuggestion
            run={run}
            paths={suggested}
            allowed={recycleAllowed}
            onCapability={(allowed) => onCapability("recycleFiles", allowed)}
          />
        )}

        <section className="detail-section">
          <h3>
            Activity
            {card.active && <span className="live">Live</span>}
          </h3>
          {activity.length > 0 ? (
            <ol className="activity">
              {activity.map((row, i) => {
                const waiting = card.state === "needs" && i === activity.length - 1 && !row.failed;
                return (
                  <li key={`${row.at}-${i}`}>
                    <span className="when">{ago(row.at, now)}</span>
                    <span className="tool">{row.tool}</span>
                    <span className="what" title={row.summary}>
                      {row.summary}
                    </span>
                    {row.failed && <span className="outcome failed">failed</span>}
                    {waiting && <span className="outcome waiting">waiting</span>}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="detail-empty">{card.active ? "No tool calls yet." : "No tool calls recorded."}</p>
          )}
        </section>
      </div>

      <div className="detail-actions">
        {link && (
          <button className={made ? "primary" : ""} onClick={() => openUrl(link)}>
            <Icon name="open" size={14} />
            {linkLabel(link)}
          </button>
        )}
        {link && made?.title === "Page created in Notion" && (
          <button onClick={() => onFollowUp(`Move the Notion page ${link} under `)}>
            <Icon name="folder" size={14} />
            Move it…
          </button>
        )}
        {run && card.active && (
          <button onClick={() => invoke("cancel_task", { id: run.id })}>
            <Icon name="stop" size={14} />
            Stop
          </button>
        )}
        {/* Once an errand made something, opening it matters more than its log; the dashboard has the log. */}
        {run?.logPath && !made && (
          <button onClick={() => revealItemInDir(run.logPath)}>
            <Icon name="file" size={14} />
            Show log
          </button>
        )}
        <button onClick={() => invoke("open_dashboard")}>
          <Icon name="open" size={14} />
          Dashboard
        </button>
      </div>
    </div>
  );
}

