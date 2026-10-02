// Geometry and motion for the blob avatars. Pure functions only: the React component
// calls `blobFrame` once per animation frame and copies the result onto its SVG.

/** The roles an agent can play. Each role has its own blob shape and colour. */
export type AvatarRole = "mc" | "code" | "web" | "desk";

/** What an avatar is showing, from calmest to most urgent. */
export type AvatarState = "idle" | "thinking" | "working" | "needs" | "done";

export type ShapeId = "orb" | "squircle" | "flower" | "capsule";

/** Radius of the shape at angle `t`, in SVG coordinates (sin(t) = -1 is the top). */
type RadiusFn = (t: number) => number;

const superellipse =
  (a: number, b: number, n: number): RadiusFn =>
  (t) =>
    Math.pow(Math.abs(Math.cos(t) / a) ** n + Math.abs(Math.sin(t) / b) ** n, -1 / n);

export const SHAPES: Record<ShapeId, RadiusFn> = {
  orb: () => 1,
  squircle: superellipse(1, 1, 4.2),
  flower: (t) => 0.9 + 0.11 * Math.cos(5 * t + Math.PI / 2),
  capsule: superellipse(1.3, 0.78, 3.2),
};

/** The blob family: you can tell agents apart by outline alone, without relying on colour. */
export const ROLE_SHAPE: Record<AvatarRole, ShapeId> = {
  mc: "orb",
  code: "squircle",
  web: "flower",
  desk: "capsule",
};

export const ROLE_COLOR: Record<AvatarRole, string> = {
  mc: "#d4d4d8",
  code: "#60a5fa",
  web: "#2dd4bf",
  desk: "#f472b6",
};

type Motion = { amp: number; speed: number; spin: number; hop: boolean; dim: boolean };

/** How each state moves: wobble amount and speed, spin, hop and dimming. */
export const MOTION: Record<AvatarState, Motion> = {
  idle: { amp: 0.018, speed: 0.5, spin: 0, hop: false, dim: true },
  thinking: { amp: 0.05, speed: 1.1, spin: 0, hop: false, dim: false },
  working: { amp: 0.075, speed: 2.6, spin: 0.5, hop: false, dim: false },
  needs: { amp: 0.035, speed: 1.4, spin: 0, hop: true, dim: false },
  done: { amp: 0.012, speed: 0.6, spin: 0, hop: false, dim: false },
};

/** Points sampled around the outline. More is smoother; 40 is plenty at desktop sizes. */
export const OUTLINE_POINTS = 40;

/** The SVG viewBox every blob is drawn in; shapes reach about ±1.3 before wobble. */
export const VIEWBOX = "-1.6 -1.6 3.2 3.2";

type Transform = { scale: number; sx: number; sy: number; dy: number };

/** Builds a closed, smooth SVG path for a wobbling shape at time `tau` (seconds). */
export function outline(shape: ShapeId, state: AvatarState, tau: number, seed: number, tf: Transform): string {
  const radius = SHAPES[shape];
  const m = MOTION[state];
  const rot = m.spin * tau;
  const pts: [number, number][] = [];
  for (let i = 0; i < OUTLINE_POINTS; i++) {
    const t = (i / OUTLINE_POINTS) * Math.PI * 2;
    const wobble =
      m.amp *
      (0.55 * Math.sin(3 * t + 1.3 * tau * m.speed + seed) +
        0.3 * Math.sin(5 * t - 1.7 * tau * m.speed) +
        0.25 * Math.sin(2 * t + 0.9 * tau * m.speed + seed * 2));
    const r = radius(t - rot) * (1 + wobble) * tf.scale;
    pts.push([r * Math.cos(t) * tf.sx, r * Math.sin(t) * tf.sy + tf.dy]);
  }

  // Closed Catmull-Rom spline through the points, written as cubic Béziers.
  const n = OUTLINE_POINTS;
  let d = `M${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return d + "Z";
}

export type Eyes =
  | { kind: "open"; left: Ellipse; right: Ellipse }
  /** Happy, upturned arcs, used when a turn is done. */
  | { kind: "happy"; left: string; right: string };

type Ellipse = { cx: number; cy: number; rx: number; ry: number };

export type BlobFrame = {
  body: string;
  /** The pulsing "needs you" ring, in the blob's own shape. */
  ring: { d: string; opacity: number } | null;
  eyes: Eyes;
  dim: boolean;
};

const EYE_X = 0.32;
const BLINK_EVERY = 4.6;
const BLINK_FOR = 0.12;
const HOP_HEIGHT = 0.28;

/** Everything needed to draw one blob at time `tau` seconds. */
export function blobFrame(shape: ShapeId, state: AvatarState, tau: number, seed: number): BlobFrame {
  const m = MOTION[state];

  // "Needs you" hops: lift off for the first 30% of each beat, squash on landing.
  const beat = mod(tau * 0.75 + seed, 1);
  const lift = m.hop && beat < 0.3 ? Math.sin((beat / 0.3) * Math.PI) * HOP_HEIGHT : 0;
  const squash = m.hop && beat >= 0.3 && beat < 0.42 ? Math.sin(((beat - 0.3) / 0.12) * Math.PI) * 0.08 : 0;
  const breathe = state === "idle" ? 1 - 0.03 * (1 + Math.sin(tau * 1.6 + seed)) : 1;
  const scale = 0.98 * breathe;
  const dy = -lift + squash * 0.9;

  const body = outline(shape, state, tau, seed, { scale, sx: 1 + squash, sy: 1 - squash, dy });
  const ring = m.hop
    ? { d: outline(shape, state, tau, seed, { scale: scale * (1.08 + beat * 0.32), sx: 1, sy: 1, dy: 0 }), opacity: 1 - beat }
    : null;

  // Eyes ride along with the body and glance up and around while thinking.
  const thinking = state === "thinking";
  const eyeY = dy - 0.06 + (thinking ? -0.14 + Math.sin(tau * 1.3) * 0.03 : 0);
  if (state === "done") {
    const arc = (x: number) => `M${fmt(x - 0.13)} ${fmt(eyeY + 0.05)} q0.13 -0.2 0.26 0`;
    return { body, ring, dim: m.dim, eyes: { kind: "happy", left: arc(-EYE_X), right: arc(EYE_X) } };
  }
  const shiftX = thinking ? Math.sin(tau * 0.9 + seed) * 0.05 : 0;
  const open = mod(tau + seed, BLINK_EVERY) < BLINK_FOR ? 0.12 : 1;
  const size = state === "needs" ? 1.25 : 1;
  const eye = (x: number): Ellipse => ({ cx: x + shiftX, cy: eyeY, rx: 0.1 * size, ry: 0.16 * size * open });
  return { body, ring, dim: m.dim, eyes: { kind: "open", left: eye(-EYE_X), right: eye(EYE_X) } };
}

/** Blends two `#rrggbb` colours; `amount` 0 keeps `from`, 1 gives `to`. */
export function mixHex(from: string, to: string, amount: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * amount));
  return "#" + out.map((c) => c.toString(16).padStart(2, "0")).join("");
}

function mod(a: number, n: number) {
  return ((a % n) + n) % n;
}

function fmt(n: number) {
  return n.toFixed(3);
}
