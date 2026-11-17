// The island's window and eyes: sizing the transparent window around the island as it morphs,
// the eyes following the cursor, and which results you have already looked at.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { lookOffset, resizeSteps, windowFor, type Size } from "./island";

/** Matches --morph in Pill.css, so the window shrinks only after the island has. */
export const MORPH_MS = 280;

/**
 * Measures the island's content and returns the size the island should take, so CSS can morph
 * between sizes. The window follows: it grows straight away and shrinks after the morph.
 */
export function useMorphSize(content: RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  const windowSize = useRef<Size>({ width: 240, height: 72 });
  const shrink = useRef<number>(undefined);

  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => {
      const next = { width: el.offsetWidth, height: el.offsetHeight };
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [content]);

  useEffect(() => {
    if (!size) return;
    const { now, later } = resizeSteps(windowSize.current, windowFor(size));
    window.clearTimeout(shrink.current);
    if (now) {
      windowSize.current = now;
      invoke("set_pill_size", { ...now });
    }
    if (later) {
      shrink.current = window.setTimeout(() => {
        windowSize.current = later;
        invoke("set_pill_size", { ...later });
      }, MORPH_MS + 40);
    }
  }, [size]);

  return size;
}

/**
 * Turns the eyes inside `root` toward the cursor while `live`. The island only hears pointer
 * events over its own window, so it polls the desktop cursor. Writes CSS variables directly so
 * following the cursor never re-renders the island.
 */
export function useLookAt(live: boolean, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!live || !el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const win = getCurrentWindow();
    let stopped = false;
    (async () => {
      let origin = await win.innerPosition();
      let scale = await win.scaleFactor();
      for (let tick = 0; !stopped; tick++) {
        // The window rarely moves, so its position is only re-read every second or so.
        if (tick % 20 === 0) [origin, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
        const cursor = await cursorPosition();
        // The face changes with the moment, so it is found afresh; the variables cascade to it.
        const box = (el.querySelector(".mc-face") ?? el).getBoundingClientRect();
        const x = (cursor.x - origin.x) / scale - (box.left + box.width / 2);
        const y = (cursor.y - origin.y) / scale - (box.top + box.height / 2);
        const look = lookOffset(x, y);
        el.style.setProperty("--look-x", `${look.x.toFixed(2)}px`);
        el.style.setProperty("--look-y", `${look.y.toFixed(2)}px`);
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    })().catch(() => {
      // No desktop cursor: the eyes simply look ahead.
    });
    return () => {
      stopped = true;
      el.style.removeProperty("--look-x");
      el.style.removeProperty("--look-y");
    };
  }, [live, root]);
}

const SEEN_KEY = "mc.island.seen";

/**
 * Results you have already looked at, so the island settles back to rest. Kept in this window's
 * storage so a restart does not bring old news back; storage may be unavailable, so it is optional.
 */
export function useSeen(): [ReadonlySet<string>, (key: string) => void] {
  const [seen, setSeen] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]"));
    } catch {
      return new Set<string>();
    }
  });
  const markSeen = useCallback((key: string) => {
    setSeen((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set([...prev, key].slice(-100));
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify([...next]));
      } catch {
        // Not remembered across restarts; the result still settles for now.
      }
      return next;
    });
  }, []);
  return [seen, markSeen];
}
