// Small stroke icons shared by the pill and the home window.

export const ICONS = {
  open: "M9.5 2.5h4v4M13.5 2.5 8 8M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3",
  collapse: "M4 10l4-4 4 4",
  send: "M8 13V3M4 7l4-4 4 4",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  check: "M3.5 8.5l3 3 6-7",
  stop: "M4.5 4.5h7v7h-7z",
  file: "M4 1.5h5l3 3v10H4zM9 1.5v3h3",
  folder: "M1.5 4.5a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z",
  plus: "M8 3v10M3 8h10",
  prompt: "M3 4l4 4-4 4M8.5 12h4.5",
  back: "M10 3.5 5.5 8l4.5 4.5",
  chevron: "M6 3.5 10.5 8 6 12.5",
  terminal: "M2 3.5h12v9H2zM4.5 6.5l2 1.5-2 1.5M8 10h3",
  shield: "M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z",
  image: "M2.5 3h11v10h-11zM5.5 6.5h.01M13.5 11 10 7.5l-6 5.5",
  pdf: "M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8h4M6 10.5h4",
  refresh: "M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3",
  apps: "M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z",
  play: "M5 3.5v9l7-4.5z",
  pause: "M6 4v8M10 4v8",
  next: "M4 3.5v9l6-4.5zM12 3.5v9",
  volumeUp: "M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 5.5a3.5 3.5 0 0 1 0 5M10.5 8h4M12.5 6v4",
  volumeDown: "M2.5 6h2.5L8.5 3v10L5 10H2.5zM10.5 8h4",
  globe: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM2.5 8h11M8 2.5c1.8 1.6 2.6 3.4 2.6 5.5S9.8 11.9 8 13.5C6.2 11.9 5.4 10.1 5.4 8S6.2 4.1 8 2.5z",
  recycle: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  link: "M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1",
  home: "M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5h-3v-4H6v4H3a.5.5 0 0 1-.5-.5z",
  tasks: "M6 4h7.5M6 8h7.5M6 12h7.5M2.5 4h.01M2.5 8h.01M2.5 12h.01",
  code: "M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5",
  sliders: "M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 3v3M6 10v3",
  sparkle: "M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z",
  reply: "M6.5 4 3 7.5 6.5 11M3 7.5h6.5a3.5 3.5 0 0 1 3.5 3.5v1",
  clock: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5",
  arrow: "M3 8h10M9 4l4 4-4 4",
  warning: "M8 2.5 14 13H2zM8 6.5v3M8 11.5h.01",
  branch: "M5 2.5v8M5 10.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11 7.5c0 2.5-2 3-6 3",
  power: "M8 2.5v5M4.5 4.8a5 5 0 1 0 7 0",
};

/** Small stroke icons, drawn in the text colour. */
export function Icon({ name, size = 16, className }: { name: keyof typeof ICONS; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
