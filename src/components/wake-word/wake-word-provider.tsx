"use client";
import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { useWakeWord } from "@/lib/hooks/use-wake-word";
import { getBrand } from "@/lib/brand";

const STORAGE_KEY = "cosmos:wake-word-enabled";

export function WakeWordProvider() {
  const [enabled, setEnabled] = useState(false);
  const brand = getBrand();

  // Load persisted state on mount (client-only)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    // Hydrate the toggle from localStorage (external system) on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnabled(stored === "true");
  }, []);

  const { listening } = useWakeWord({
    phrase: brand.wakePhrase,
    enabled,
    onWake: () => {
      window.dispatchEvent(new CustomEvent("cosmos:command-palette:open"));
    },
  });

  // Toggle is fired from the sidebar/user-card via a custom event so the
  // control can live elsewhere; this provider owns the actual recognition.
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

  function disable() {
    setEnabled(false);
    window.localStorage.setItem(STORAGE_KEY, "false");
  }

  // LIVE indicator: while the mic is actually listening, show a small pulsing
  // pill so the user always knows voice capture is on (and can switch it off
  // in one click). Placed bottom-left, clear of the agent bubble (bottom-right)
  // and the mobile bottom nav (raised on small screens).
  if (!listening) return null;

  return (
    <button
      type="button"
      onClick={disable}
      aria-label={`Listening for “${brand.wakeWord}” — click to turn off`}
      title={`Listening for “${brand.wakeWord}” — click to turn off`}
      className="fixed bottom-20 left-4 z-50 flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--overlay)] py-1.5 pl-2.5 pr-3 text-xs font-medium text-[var(--text)] shadow-lg backdrop-blur transition-colors hover:border-destructive/50 md:bottom-4"
    >
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
      </span>
      <Mic className="h-3.5 w-3.5" />
      <span>Listening…</span>
    </button>
  );
}
