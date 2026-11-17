// Hooks shared by the island and the Desk for reading the runtime's live state.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Subscribes to a backend event, seeded from a snapshot command so it is filled straight away. */
export function useBackend<T>(command: string, event: string, initial: T): T {
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

/** The current time, ticking once a second while `live`, for elapsed times. */
export function useNow(live: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}
