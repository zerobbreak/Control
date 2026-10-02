import { describe, expect, it } from "vitest";
import {
  blobFrame,
  mixHex,
  MOTION,
  OUTLINE_POINTS,
  outline,
  ROLE_SHAPE,
  SHAPES,
  type AvatarRole,
  type AvatarState,
  type ShapeId,
} from "./blob";

const STATES = Object.keys(MOTION) as AvatarState[];
const SHAPE_IDS = Object.keys(SHAPES) as ShapeId[];
const STILL = { scale: 1, sx: 1, sy: 1, dy: 0 };

/** Every number in an SVG path string. */
const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

/** Vertical extent of a path's points (control points included, which bound the curve). */
function yRange(d: string) {
  const ys = numbers(d).filter((_, i) => i % 2 === 1);
  return { top: Math.min(...ys), bottom: Math.max(...ys) };
}

describe("shapes", () => {
  it.each(SHAPE_IDS)("%s has a finite, positive radius all the way round", (id) => {
    for (let i = 0; i < 720; i++) {
      const r = SHAPES[id]((i / 720) * Math.PI * 2);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(0.6);
      expect(r).toBeLessThan(1.4);
    }
  });

  it("gives every agent role a different shape, so they can be told apart without colour", () => {
    const shapes = Object.values(ROLE_SHAPE);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("makes Mission Control the orb", () => {
    expect(ROLE_SHAPE.mc).toBe("orb");
  });
});

describe("outline", () => {
  it.each(SHAPE_IDS)("draws %s as one closed smooth curve", (id) => {
    const d = outline(id, "working", 1.5, 3, STILL);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.match(/C/g)).toHaveLength(OUTLINE_POINTS);
    expect(numbers(d).every(Number.isFinite)).toBe(true);
  });

  it("is deterministic for the same time and seed", () => {
    expect(outline("flower", "thinking", 2.25, 7, STILL)).toBe(outline("flower", "thinking", 2.25, 7, STILL));
  });

  it("changes over time, which is what makes it wobble", () => {
    expect(outline("orb", "working", 0, 1, STILL)).not.toBe(outline("orb", "working", 0.5, 1, STILL));
  });

  it.each(STATES)("stays inside the 3.2-unit viewBox while %s", (state) => {
    for (const id of SHAPE_IDS) {
      for (let tau = 0; tau < 6; tau += 0.37) {
        const frame = blobFrame(id, state, tau, 11);
        for (const n of numbers(frame.body)) expect(Math.abs(n)).toBeLessThan(1.6);
      }
    }
  });

  it("wobbles more while working than while idle", () => {
    const spread = (state: AvatarState) => {
      const radii = [];
      for (let tau = 0; tau < 4; tau += 0.1) {
        const { top, bottom } = yRange(outline("orb", state, tau, 5, STILL));
        radii.push(bottom - top);
      }
      return Math.max(...radii) - Math.min(...radii);
    };
    expect(spread("working")).toBeGreaterThan(spread("idle") * 2);
  });
});

describe("blobFrame", () => {
  it("shows the amber ring only when the agent needs you", () => {
    for (const state of STATES) {
      expect(blobFrame("orb", state, 0.2, 0).ring !== null).toBe(state === "needs");
    }
  });

  it("hops when the agent needs you", () => {
    let highest = Infinity;
    for (let tau = 0; tau < 1.4; tau += 0.02) highest = Math.min(highest, yRange(blobFrame("orb", "needs", tau, 0).body).top);
    const resting = yRange(blobFrame("orb", "working", 0, 0).body).top;
    expect(highest).toBeLessThan(resting - 0.15);
  });

  it("stays put in every other state", () => {
    for (const state of STATES.filter((s) => s !== "needs")) {
      for (let tau = 0; tau < 3; tau += 0.1) {
        expect(yRange(blobFrame("orb", state, tau, 0).body).top).toBeGreaterThan(-1.15);
      }
    }
  });

  it("smiles when done and has open eyes otherwise", () => {
    for (const state of STATES) {
      expect(blobFrame("squircle", state, 1, 2).eyes.kind).toBe(state === "done" ? "happy" : "open");
    }
  });

  it("blinks now and then", () => {
    const heights = [];
    for (let tau = 0; tau < 5; tau += 0.02) {
      const eyes = blobFrame("orb", "idle", tau, 0).eyes;
      if (eyes.kind === "open") heights.push(eyes.left.ry);
    }
    expect(Math.min(...heights)).toBeLessThan(Math.max(...heights) * 0.2);
    expect(heights.filter((h) => h < 0.05).length).toBeLessThan(heights.length * 0.1);
  });

  it("looks up while thinking", () => {
    const eyeY = (state: AvatarState) => {
      const eyes = blobFrame("orb", state, 0.4, 0).eyes;
      return eyes.kind === "open" ? eyes.left.cy : NaN;
    };
    expect(eyeY("thinking")).toBeLessThan(eyeY("working") - 0.08);
  });

  it("dims only when idle", () => {
    for (const state of STATES) expect(blobFrame("capsule", state, 0, 0).dim).toBe(state === "idle");
  });

  it("copes with negative times and big seeds", () => {
    const roles: AvatarRole[] = ["mc", "code", "web", "desk"];
    for (const role of roles) {
      const frame = blobFrame(ROLE_SHAPE[role], "needs", -3.7, 9999);
      expect(numbers(frame.body).every(Number.isFinite)).toBe(true);
      expect(frame.ring!.opacity).toBeGreaterThanOrEqual(0);
      expect(frame.ring!.opacity).toBeLessThanOrEqual(1);
    }
  });
});

describe("mixHex", () => {
  it("blends towards the target colour", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#60a5fa", "#000000", 0.5)).toBe("#30537d");
  });
});
