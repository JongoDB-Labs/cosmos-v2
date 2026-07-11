"use client";
import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { createPortal } from "react-dom";
import { useWakeWord } from "@/lib/hooks/use-wake-word";
import { useBrand } from "@/components/providers/brand-provider";

const STORAGE_KEY = "cosmos:wake-word-enabled";

export function WakeWordProvider() {
  const [enabled, setEnabled] = useState(false);
  // While the assistant's dictation mic is live, the wake listener pauses — two
  // concurrent recognition sessions fight over the microphone (reference:
  // okr-dashboard gates its wake loop on chatOpen the same way).
  const [dictating, setDictating] = useState(false);
  const brand = useBrand();

  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setDictating(Boolean(detail));
    };
    window.addEventListener("cosmos:assistant:dictation:state", onState);
    return () => window.removeEventListener("cosmos:assistant:dictation:state", onState);
  }, []);

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
    enabled: enabled && !dictating,
    onWake: () => {
      // "Hey Cosmo" → open the assistant and hand the mic to dictation. The
      // panel mounts only when the drawer opens, so a timed event alone races
      // its mount — the sessionStorage flag is the handshake: a panel that
      // mounts later consumes it and starts dictation itself.
      try {
        window.sessionStorage.setItem("cosmos:dictate-on-open", "1");
      } catch {
        /* storage unavailable — the event below still covers an open panel */
      }
      window.dispatchEvent(new CustomEvent("cosmos:agent:open"));
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("cosmos:assistant:dictation:start"));
      }, 450);
    },
  });

  // Broadcast the ACTUAL live-mic state so out-of-tree controls (the sidebar
  // toggle) reflect it truthfully — they show the filled/active state and the
  // "listening" warning only while the mic is really capturing, never merely
  // because the toggle is switched on. The recognition session lives only here,
  // so an event is the one way peers can learn the real listening state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("cosmos:wake-word:listening", { detail: listening }),
    );
  }, [listening]);

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
    // Same-tab `storage` events don't fire — tell the sidebar toggle explicitly.
    window.dispatchEvent(new CustomEvent("cosmos:wake-word:toggle", { detail: false }));
  }

  // LIVE indicator: while the mic is actually listening, show a small pulsing
  // pill so the user always knows voice capture is on (and can switch it off
  // in one click). Placed bottom-left, clear of the agent bubble (bottom-right)
  // and the mobile bottom nav (raised on small screens).
  if (!listening) return null;

  // PORTALED to <body>: when the assistant drawer is open, its a11y scoping
  // (inert/aria-hidden background) swallowed the in-tree pill — visible but
  // unclickable, so "click to turn off" silently did nothing (the stuck-pill
  // bug). A body-level portal keeps it interactive above any drawer.
  return createPortal(
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
    </button>,
    document.body,
  );
}
