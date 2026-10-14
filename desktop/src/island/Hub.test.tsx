import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hub } from "./Hub";

const noop = () => {};

describe("Hub", () => {
  it("shows the mascot and one tinted tile per agent, in a 2x2 grid", () => {
    const html = renderToStaticMarkup(
      <Hub
        cards={[]}
        seen={new Set()}
        feed={[]}
        clis={[
          { id: "claude", name: "Claude", version: "2.0.0" },
          { id: "gemini", name: "Gemini", version: null },
        ]}
        onPick={noop}
        onDesk={noop}
        onQuit={noop}
      />,
    );
    expect(html).toContain("hub-mascot");
    expect(html).toContain("mc-face idle large");
    for (const id of ["claude", "gemini", "browser", "assistant"]) {
      expect(html).toContain(`tile ${id}`);
      expect(html).toContain(`tint-${id}`);
    }
    expect(html.match(/class="tile /g)).toHaveLength(4);
    expect(html).toContain("Not connected");
  });
});
