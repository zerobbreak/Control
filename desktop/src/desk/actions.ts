// The Desk's calls into the runtime, shared by Today and the run view.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NowPlaying, PendingApproval, Settings } from "../types";

export function answerApproval(request: PendingApproval, allow: boolean) {
  return invoke<boolean>("answer_approval", { runId: request.runId, requestId: request.requestId, allow });
}

/** Adds a command to the always-allow list, then lets this request through. */
export async function alwaysAllow(settings: Settings, request: PendingApproval, prefix: string) {
  if (!settings.autoApprove.includes(prefix)) {
    await invoke<Settings>("update_settings", { settings: { ...settings, autoApprove: [...settings.autoApprove, prefix] } });
  }
  return answerApproval(request, true);
}

export function saveSettings(settings: Settings) {
  return invoke<Settings>("update_settings", { settings });
}

/** What is playing, only while the user has allowed media controls; media_now can fail. */
export function useNowPlaying(enabled: boolean): NowPlaying | null {
  const [media, setMedia] = useState<NowPlaying | null>(null);
  useEffect(() => {
    if (!enabled) {
      setMedia(null);
      return;
    }
    invoke<NowPlaying | null>("media_now").then(setMedia, () => setMedia(null));
    const unlisten = listen<NowPlaying | null>("media-updated", (e) => setMedia(e.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [enabled]);
  return media;
}
