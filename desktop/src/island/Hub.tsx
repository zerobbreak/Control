// The island opened: the mascot on the left, and one tile per agent on the right in a 2x2 grid.
// Every tile has the same face in its agent's gradient, and tiles work independently, so Claude
// and Gemini can each be on their own goal at once.

import { Face, type FaceState } from "../Face";
import { Icon } from "../Icon";
import { STATE_LABEL } from "../avatar/pillState";
import type { AgentCard } from "../runs";
import type { AgentEvent, CliStatus } from "../types";
import { currentAction, HUB, hubOf, hubTiles, type HubId } from "./island";

type Props = {
  cards: AgentCard[];
  seen: ReadonlySet<string>;
  feed: AgentEvent[];
  clis: CliStatus[];
  /** A tile was chosen: its card when it has live work or a fresh result, else null to prompt it. */
  onPick: (id: HubId, card: AgentCard | null) => void;
  onDesk: () => void;
  onQuit: () => void;
};

/** What a tile says under its name. */
function tileLine(card: AgentCard | null, feed: AgentEvent[], missing: boolean): string {
  if (missing) return "Not connected";
  if (!card) return "Ready";
  if (card.active) {
    if (card.state === "needs") return "Needs you";
    const action = currentAction(card, feed, true);
    return `${action.verb}${action.object ? ` ${action.object}` : ""}`;
  }
  return card.run?.status === "failed" ? "Didn't finish" : "Done";
}

export function Hub({ cards, seen, feed, clis, onPick, onDesk, onQuit }: Props) {
  const tiles = hubTiles(cards, seen);
  const live = cards.filter((c) => c.active);
  const lead = live.length > 0 ? live.reduce((a, b) => (rank(b) > rank(a) ? b : a)) : null;
  const summary = live.length === 0 ? "All ready" : `${live.length} working`;

  return (
    <section className="card hub" aria-label="Agents">
      <div className="hub-mascot">
        <Face state={lead ? lead.state : "idle"} role={lead?.role} large />
        <strong>Mission Control</strong>
        <span className={`hub-summary ${live.length > 0 ? "busy" : ""}`}>{summary}</span>
        <span className="hub-tools">
          <button className="icon-btn" aria-label="Open the Desk" title="Open the Desk" onClick={onDesk}>
            <Icon name="open" size={13} />
          </button>
          <button className="icon-btn" aria-label="Quit Mission Control" title="Quit Mission Control" onClick={onQuit}>
            <Icon name="power" size={13} />
          </button>
        </span>
      </div>
      <div className="hub-grid" role="group" aria-label="Agents">
        {HUB.map((agent) => {
          const card = tiles[agent.id];
          const cli = clis.find((c) => c.id === agent.id);
          // Only the two coding CLIs can be missing; the browser and assistant ride on Claude Code.
          const missing = (agent.id === "claude" || agent.id === "gemini") && clis.length > 0 && !cli?.version && !card;
          const state: FaceState = card ? (card.active || card.state === "done" ? card.state : "failed") : "idle";
          const line = tileLine(card, feed, missing);
          return (
            <button
              key={agent.id}
              className={`tile ${agent.id} ${card?.active ? "live" : ""} ${missing ? "missing" : ""} ${card && !card.active ? "result" : ""}`}
              onClick={() => onPick(agent.id, card)}
              title={cli?.version ? `${agent.sub} · ${cli.version}` : agent.sub}
              aria-label={`${agent.name}: ${line}`}
            >
              <Face state={state} role={card?.role} tint={agent.id} small />
              <span className="tile-name">{agent.name}</span>
              <span className="tile-line one-line">{line}</span>
              <span className="tile-state mono">{card ? STATE_LABEL[card.state] : missing ? "" : agent.sub}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const ORDER = ["idle", "done", "thinking", "working", "needs"];
function rank(card: AgentCard): number {
  return ORDER.indexOf(card.state);
}

export { hubOf };
