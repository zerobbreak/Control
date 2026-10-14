import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as pickPaths } from "@tauri-apps/plugin-dialog";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./theme.css";
import { useBackend, useNow } from "./backend";
import { ComposeCard } from "./ContextViews";
import { CapabilityCard, RecycleCard, useDescribed } from "./Assistant";
import { CAPABILITIES, recycleSuggestions } from "./capabilities";
import { splitContext } from "./context";
import { agentCards, pillCards, sessionView } from "./runs";
import { Collapsed } from "./island/Collapsed";
import { Hub } from "./island/Hub";
import { ApprovalCard, DropCard, ResultCard, WorkCard } from "./island/Cards";
import { useLookAt, useMorphSize, useSeen } from "./island/hooks";
import { crewOf, islandCards, islandMoment, reviewView, seenKey, withRemembered, type HubId, type Remember } from "./island/island";
import type {
  App,
  BoardSnapshot,
  Capability,
  CliStatus,
  ContextItem,
  MediaAction,
  NowPlaying,
  PendingApproval,
  Preview,
  RunSummary,
  Settings,
} from "./types";
import "./Pill.css";

/**
 * What is playing, kept fresh by the runtime while media controls are allowed. Before that the
 * island never asks.
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

/** A card the user asked for, over the one the moment would pick. */
type Override = "compose" | "recycle" | null;

export default function Pill() {
  const board = useBackend<BoardSnapshot>("board_snapshot", "board-updated", { sessions: [], feed: [] });
  const runs = useBackend<RunSummary[]>("runs_snapshot", "runs-updated", []);
  const approvals = useBackend<PendingApproval[]>("approvals_snapshot", "approvals-updated", []);
  const settings = useBackend<Settings | null>("get_settings", "settings-updated", null);
  const media = useMedia(settings?.capabilities.mediaControls === true);
  const [expanded, setExpanded] = useState(false);
  const [override, setOverride] = useState<Override>(null);
  const [prompt, setPrompt] = useState("");
  // Files and folders handed over for the next goal; the first code project is where it runs.
  const [context, setContext] = useState<ContextItem[]>([]);
  const [dropping, setDropping] = useState<ContextItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  // The plan, and the goal and context it was made for: editing either makes it stale.
  const [planned, setPlanned] = useState<{ key: string; preview: Preview } | null>(null);
  // A capability Go is waiting on the user's answer for.
  const [asking, setAsking] = useState<Capability | null>(null);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [apps, setApps] = useState<App[] | null>(null);
  const [clis, setClis] = useState<CliStatus[]>([]);
  // The agent whose tile the goal was opened from; it takes the goal, whatever else is running.
  const [target, setTarget] = useState<HubId | null>(null);
  // The agent card shown in detail, chosen from its tile.
  const [focus, setFocus] = useState<string | null>(null);
  const [seen, markSeen] = useSeen();
  // A native file picker takes focus from the island; that must not tuck it away.
  const picking = useRef(false);
  const island = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const size = useMorphSize(content);
  const now = useNow(true);
  useLookAt(expanded, island);

  const watched = board.sessions.filter((s) => s.status !== "idle");
  const cards = islandCards(pillCards(agentCards(runs, watched, approvals, sessionView), now));
  const { moment, card } = islandMoment(cards, seen, media !== null);
  const crew = crewOf(cards, card);
  const waiting = [...approvals].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  const { folder, attachments } = splitContext(context);
  const planKey = `${target ?? ""}\n${prompt.trim()}\n${context.map((c) => c.path).join("\n")}`;
  const agent = target === "claude" || target === "gemini" ? target : undefined;
  const preview = planned?.key === planKey ? planned.preview : null;
  // Files a finished assistant suggested removing, offered from its result card.
  const focusCard = (focus && cards.find((c) => c.key === focus)) || null;
  const subject = focusCard ?? card;
  const showsResult = focusCard ? !focusCard.active : moment === "done" || moment === "failed";
  const resultRun = (showsResult && subject && !subject.active && subject.run?.status === "finished" && subject.run) || null;
  const suggested = useDescribed(resultRun ? recycleSuggestions(resultRun.result).paths : []);
  // Media controls are asked about once the browser agent has finished something.
  const askMedia =
    settings !== null &&
    settings.capabilities.mediaControls === undefined &&
    runs.some((r) => r.decision.task === "browse" && r.status === "finished");

  const view = dropping
    ? "drop"
    : override === "recycle" && resultRun && suggested.length > 0
      ? "recycle"
      : asking
        ? "capability"
        : override === "compose"
          ? "compose"
          : waiting.length > 0
            ? "approve"
            : focusCard
              ? focusCard.active
                ? "work"
                : "result"
              : (moment === "done" || moment === "failed") && card
                ? "result"
                : askMedia
                  ? "media"
                  : "hub";
  const showing = expanded ? view : "collapsed";

  function expand() {
    setExpanded(true);
  }

  function collapse() {
    // Opening a result is looking at it, so it settles back to rest.
    if (expanded && view === "result" && subject) markSeen(seenKey(subject));
    setExpanded(false);
    setOverride(null);
    setAsking(null);
    setFocus(null);
    setTarget(null);
  }

  // Clicking anywhere else on the desktop tucks the island away; Escape does too.
  const collapseRef = useRef(collapse);
  collapseRef.current = collapse;
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused && !picking.current) collapseRef.current();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") collapseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unlisten.then((stop) => stop());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Files and folders dragged onto the island become context for the next goal.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter") {
        setDropping([]);
        setExpanded(true);
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

  // Which apps are connected takes Claude Code a few seconds to check, so @ mentions ask once, early.
  useEffect(() => {
    if (expanded && apps === null) invoke<App[]>("list_apps").then(setApps, () => setApps([]));
  }, [expanded]);

  // Which agent CLIs are installed: checked at start and again whenever the island opens, so
  // installing one shows up without a restart.
  useEffect(() => {
    invoke<CliStatus[]>("cli_status").then(setClis, () => setClis([]));
  }, [expanded]);

  async function saveSettings(next: Settings) {
    await invoke<Settings>("update_settings", { settings: next });
  }

  /** Saves the user's answer for a capability; the runtime enforces it from then on. */
  async function setCapability(capability: Capability, allowed: boolean) {
    if (!settings) return;
    try {
      await saveSettings({ ...settings, capabilities: { ...settings.capabilities, [capability]: allowed } });
    } catch (err) {
      setError(String(err));
    }
  }

  async function remember(rule: Remember) {
    if (settings) await saveSettings(withRemembered(settings, rule));
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

  /** Adds files and folders as context for the next goal and opens the goal card around them. */
  async function attach(paths: string[]) {
    const items = await describe(paths);
    setContext((current) => [...current, ...items.filter((i) => !current.some((c) => c.path === i.path))]);
    setOverride("compose");
    setExpanded(true);
  }

  /** The + button's alternative to dragging: pick files or a folder with the system dialog. */
  async function browse(directory: boolean) {
    picking.current = true;
    try {
      const picked = await pickPaths({ directory, multiple: true, title: directory ? "Add a folder" : "Add files" });
      if (picked) await attach(Array.isArray(picked) ? picked : [picked]);
    } finally {
      picking.current = false;
    }
  }

  /** Asks the router who would do the goal, without starting anything. */
  async function plan(): Promise<Preview | null> {
    if (!prompt.trim() || planning) return null;
    setPlanning(true);
    setError(null);
    try {
      const next = await invoke<Preview>("preview_task", { prompt, folder, attachments, agent });
      setPlanned({ key: planKey, preview: next });
      return next;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setPlanning(false);
    }
  }

  /** Starts the goal once it is planned and any capability it needs is allowed. */
  async function go() {
    const ready = preview ?? (await plan());
    if (!ready) return;
    if (ready.capability && ready.capabilityGranted !== true) {
      if (ready.capabilityGranted === null) setAsking(ready.capability);
      else setError(`${CAPABILITIES[ready.capability].name} is turned off. Change it in Boundaries on the Desk.`);
      return;
    }
    await start();
  }

  async function start() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const run = await invoke<RunSummary>("start_task", { prompt, folder, attachments, agent });
      setPrompt("");
      setContext([]);
      setPlanned(null);
      setOverride(null);
      setTarget(null);
      // Show the new run in detail; the back arrow returns to the grid with the others running.
      setFocus(run.id);
    } catch (err) {
      setError(String(err));
      setOverride("compose");
    } finally {
      setStarting(false);
    }
  }

  /** The answer to a capability Go was waiting on; allowed, the goal starts with a fresh plan. */
  async function answerCapability(capability: Capability, allowed: boolean) {
    await setCapability(capability, allowed);
    setAsking(null);
    setOverride("compose");
    if (!allowed) return;
    const next = await invoke<Preview>("preview_task", { prompt, folder, attachments, agent }).catch(() => null);
    if (next) setPlanned({ key: planKey, preview: next });
    if (next && (!next.capability || next.capabilityGranted)) await start();
  }

  function openDesk(target: string) {
    invoke("open_dashboard", { view: target });
    collapse();
  }

  function review() {
    if (!subject) return;
    markSeen(seenKey(subject));
    openDesk(reviewView(subject));
  }

  function dismiss() {
    if (subject) markSeen(seenKey(subject));
    setFocus(null);
  }

  /** A tile was chosen: look at its live work or fresh result, otherwise open a goal for that agent. */
  function pickTile(id: HubId, picked: (typeof cards)[number] | null) {
    if (picked) return setFocus(picked.key);
    if ((id === "claude" || id === "gemini") && !clis.find((c) => c.id === id)?.version) return openDesk("boundaries");
    setTarget(id);
    setOverride("compose");
  }

  return (
    <div className="stage">
      <div
        ref={island}
        className={`island ${expanded ? "open" : ""} ${moment}`}
        style={size ? { width: size.width, height: size.height } : undefined}
      >
        <div ref={content} className={`island-content ${expanded ? "card-size" : ""}`}>
          <div key={showing} className="moment">
            {!expanded ? (
              <Collapsed
                moment={moment}
                card={card}
                crew={crew}
                feed={board.feed}
                approval={moment === "needs" ? card?.approvals[0] ?? null : null}
                media={media}
                notionParent={settings?.notionParent ?? null}
                now={now}
                onOpen={expand}
                onReview={review}
                onControl={controlMedia}
              />
            ) : view === "drop" ? (
              <DropCard items={dropping ?? []} />
            ) : view === "recycle" && resultRun ? (
              <RecycleCard
                run={resultRun}
                items={suggested}
                allowed={settings?.capabilities.recycleFiles ?? null}
                onCapability={(allowed) => setCapability("recycleFiles", allowed)}
                onBoundaries={() => openDesk("boundaries")}
                onClose={() => setOverride(null)}
              />
            ) : view === "capability" && asking ? (
              <CapabilityCard capability={asking} onAnswer={(allowed) => answerCapability(asking, allowed)} />
            ) : view === "approve" ? (
              <ApprovalCard
                approvals={waiting}
                index={approvalIndex}
                onIndex={setApprovalIndex}
                runs={runs}
                notionParent={settings?.notionParent ?? null}
                onRemember={remember}
              />
            ) : view === "hub" ? (
              <Hub
                cards={cards}
                seen={seen}
                feed={board.feed}
                clis={clis}
                onPick={pickTile}
                onDesk={() => openDesk("today")}
                onQuit={() => invoke("quit_app")}
              />
            ) : view === "work" && subject ? (
              <WorkCard
                card={subject}
                others={crewOf(cards, subject)}
                feed={board.feed}
                now={now}
                onDesk={openDesk}
                onBack={() => setFocus(null)}
                onNew={() => setOverride("compose")}
              />
            ) : view === "result" && subject ? (
              <ResultCard
                card={subject}
                notionParent={settings?.notionParent ?? null}
                suggested={suggested}
                onDismiss={dismiss}
                onReview={review}
                onRecycle={() => setOverride("recycle")}
              />
            ) : view === "media" ? (
              <CapabilityCard capability="mediaControls" onAnswer={(allowed) => setCapability("mediaControls", allowed)} />
            ) : (
              <ComposeCard
                prompt={prompt}
                onPrompt={(text) => {
                  setPrompt(text);
                  setError(null);
                }}
                context={context}
                project={folder}
                onRemove={(path) => setContext(context.filter((c) => c.path !== path))}
                onBrowse={browse}
                apps={apps ?? []}
                preview={preview}
                busy={planning || starting}
                error={error}
                onEnter={go}
                onGo={go}
                onDesk={() => openDesk("today")}
                onQuit={() => invoke("quit_app")}
                agent={target}
                onBack={() => {
                  setOverride(null);
                  setTarget(null);
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
