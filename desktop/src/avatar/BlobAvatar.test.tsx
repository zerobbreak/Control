import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlobAvatar } from "./BlobAvatar";

const render = (el: ReactElement) => renderToStaticMarkup(el);

describe("BlobAvatar", () => {
  it("draws the role's shape at the requested size, before any animation frame runs", () => {
    const html = render(<BlobAvatar role="web" state="working" size={28} />);
    expect(html).toContain('data-shape="flower"');
    expect(html).toContain('width="28"');
    expect(html).toMatch(/class="blob-body" d="M[^"]+Z"/);
  });

  it("fills the body with its own gradient", () => {
    const html = render(<BlobAvatar role="code" state="idle" size={20} />);
    const id = html.match(/<radialGradient id="([^"]+)"/)![1];
    expect(html).toContain(`fill="url(#${id})"`);
    expect(id).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it("gives two avatars different gradient ids", () => {
    const html = render(
      <>
        <BlobAvatar role="mc" state="idle" size={20} />
        <BlobAvatar role="code" state="idle" size={20} />
      </>,
    );
    const ids = [...html.matchAll(/<radialGradient id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it("adds the ring only when the agent needs you", () => {
    expect(render(<BlobAvatar role="mc" state="needs" size={30} />)).toContain("blob-ring");
    expect(render(<BlobAvatar role="mc" state="working" size={30} />)).not.toContain("blob-ring");
  });

  it("draws happy eyes when done", () => {
    const html = render(<BlobAvatar role="desk" state="done" size={30} />);
    expect(html.match(/blob-smile/g)).toHaveLength(2);
    expect(html).not.toContain("blob-eye");
  });

  it("is hidden from screen readers unless it has a title", () => {
    expect(render(<BlobAvatar role="mc" state="idle" size={30} />)).toContain('aria-hidden="true"');
    const titled = render(<BlobAvatar role="mc" state="needs" size={30} title="Mission Control: Needs you" />);
    expect(titled).toContain('role="img"');
    expect(titled).toContain('aria-label="Mission Control: Needs you"');
  });
});
