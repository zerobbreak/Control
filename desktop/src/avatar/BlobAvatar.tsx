import { useEffect, useId, useMemo, useRef, type RefObject } from "react";
import { blobFrame, gazeTowards, mixHex, ROLE_COLOR, ROLE_SHAPE, VIEWBOX, type AvatarRole, type AvatarState, type BlobFrame, type Gaze } from "./blob";

type Props = {
  role: AvatarRole;
  state: AvatarState;
  /** Rendered width and height in CSS pixels. */
  size: number;
  title?: string;
  /** A point in page coordinates to keep the eyes on, such as the cursor. Read every frame. */
  lookAt?: RefObject<{ x: number; y: number } | null>;
};

/** How far the eyes move towards their target each frame, so they glide rather than snap. */
const EASE = 0.18;

/**
 * A wobbling blob with eyes. The shape says which agent it is; the motion says what it is doing.
 * Frames are written straight onto the SVG nodes, so animating never re-renders React.
 */
export function BlobAvatar({ role, state, size, title, lookAt }: Props) {
  const shape = ROLE_SHAPE[role];
  const color = ROLE_COLOR[role];
  const gradientId = "blob" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const seed = useMemo(() => Math.random() * 100, []);
  const first = blobFrame(shape, state, 0, seed);

  const svg = useRef<SVGSVGElement>(null);
  const body = useRef<SVGPathElement>(null);
  const ring = useRef<SVGPathElement>(null);
  const left = useRef<SVGEllipseElement & SVGPathElement>(null);
  const right = useRef<SVGEllipseElement & SVGPathElement>(null);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const gaze: Gaze = { x: 0, y: 0 };
    const draw = (now: number) => {
      const target = lookAt?.current && svg.current ? towards(svg.current, lookAt.current, size) : null;
      gaze.x += ((target?.x ?? 0) - gaze.x) * EASE;
      gaze.y += ((target?.y ?? 0) - gaze.y) * EASE;
      apply(blobFrame(shape, state, now / 1000, seed, gaze), { body, ring, left, right });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [shape, state, seed, lookAt, size]);

  return (
    <svg
      ref={svg}
      className={`blob-avatar ${role} ${state}`}
      width={size}
      height={size}
      viewBox={VIEWBOX}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-shape={shape}
      data-state={state}
    >
      <defs>
        <radialGradient id={gradientId} cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor={mixHex(color, "#ffffff", 0.55)} />
          <stop offset="0.55" stopColor={color} />
          <stop offset="1" stopColor={mixHex(color, "#000000", 0.45)} />
        </radialGradient>
      </defs>
      {first.ring && (
        <path ref={ring} className="blob-ring" d={first.ring.d} opacity={first.ring.opacity} />
      )}
      <path
        ref={body}
        className="blob-body"
        d={first.body}
        fill={`url(#${gradientId})`}
        style={first.dim ? { filter: "saturate(0.35) brightness(0.8)" } : undefined}
      />
      {first.eyes.kind === "happy" ? (
        <>
          <path ref={left} className="blob-smile" d={first.eyes.left} />
          <path ref={right} className="blob-smile" d={first.eyes.right} />
        </>
      ) : (
        <>
          <ellipse ref={left} className="blob-eye" {...first.eyes.left} />
          <ellipse ref={right} className="blob-eye" {...first.eyes.right} />
        </>
      )}
    </svg>
  );
}

/** The gaze from an avatar's centre towards a page point; eyes turn fully a few sizes away. */
function towards(node: SVGSVGElement, point: { x: number; y: number }, size: number): Gaze {
  const box = node.getBoundingClientRect();
  return gazeTowards(point.x - (box.left + box.width / 2), point.y - (box.top + box.height / 2), size * 2.5);
}

type Nodes = {
  body: RefObject<SVGPathElement | null>;
  ring: RefObject<SVGPathElement | null>;
  left: RefObject<SVGElement | null>;
  right: RefObject<SVGElement | null>;
};

function apply(frame: BlobFrame, nodes: Nodes) {
  nodes.body.current?.setAttribute("d", frame.body);
  if (frame.ring && nodes.ring.current) {
    nodes.ring.current.setAttribute("d", frame.ring.d);
    nodes.ring.current.setAttribute("opacity", frame.ring.opacity.toFixed(2));
  }
  const pairs: [SVGElement | null, unknown][] = [
    [nodes.left.current, frame.eyes.left],
    [nodes.right.current, frame.eyes.right],
  ];
  for (const [node, eye] of pairs) {
    if (!node) continue;
    if (typeof eye === "string") {
      node.setAttribute("d", eye);
    } else {
      const e = eye as { cx: number; cy: number; rx: number; ry: number };
      node.setAttribute("cx", e.cx.toFixed(3));
      node.setAttribute("cy", e.cy.toFixed(3));
      node.setAttribute("rx", e.rx.toFixed(3));
      node.setAttribute("ry", e.ry.toFixed(3));
    }
  }
}
