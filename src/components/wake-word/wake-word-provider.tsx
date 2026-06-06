"use client";
import { useEffect, useState } from "react";
import { useWakeWord } from "@/lib/hooks/use-wake-word";

const STORAGE_KEY = "cosmos:wake-word-enabled";

export function WakeWordProvider() {
  const [enabled, setEnabled] = useState(false);

  // Load persisted state on mount (client-only)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    // Hydrate the toggle from localStorage (external system) on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnabled(stored === "true");
  }, []);

  useWakeWord({
    phrase: "hey cosmos",
    enabled,
    onWake: () => {
      window.dispatchEvent(new CustomEvent("cosmos:command-palette:open"));
    },
  });

  // The provider has no UI; it just listens. Toggle is handled by a sidebar button.
  // Expose the toggle via a custom event listener so the user-card dropdown can flip it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const next = typeof detail === "boolean" ? detail : !enabled;
      setEnabled(next);
      window.localStorage.setItem(STORAGE_KEY, String(next));
    };
    window.addEventListener("cosmos:wake-word:toggle", handler);
    return () =>
      window.removeEventListener("cosmos:wake-word:toggle", handler);
  }, [enabled]);

  return null;
}
