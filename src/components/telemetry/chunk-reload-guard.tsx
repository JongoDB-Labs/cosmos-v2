"use client";

import { useEffect } from "react";
import { toast } from "sonner";

import { isChunkLoadError } from "@/lib/telemetry/ignore-error";

/**
 * Recovers from stale-chunk errors after a deploy.
 *
 * Cosmos is a single self-hosted Next server: each deploy regenerates `.next`
 * with new chunk hashes and bounces the process (~1-2s) via `systemctl restart`.
 * A tab opened before a deploy can then request a chunk that 404s (or fails
 * during the restart window) → an uncaught "ChunkLoadError". This catches that
 * specific class of error and does ONE reload to pull the fresh client.
 *
 * Guards against an infinite reload loop: the reload happens at most once per
 * session window. The flag is cleared after the page has stayed up for a bit,
 * so a LATER deploy can still trigger a fresh single recovery.
 *
 * Never mid-edit (COSMOS-221): a reload while someone is typing a new issue or
 * a comment throws their input away. When there is unsaved input, a toast
 * offers the reload instead, and they take it once they are done.
 */

const RELOAD_FLAG = "cosmos:chunk-reloaded";
const UPDATE_TOAST_ID = "cosmos:update-available";

// Text-entry inputs only: a focused checkbox or button holds nothing to lose.
const TEXT_ENTRY =
  "textarea, input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([type=range]):not([type=color])";

/**
 * Whether a reload now could throw away something the user is in the middle of:
 * focus in a text field or editor, or an open dialog (forms live in dialogs and
 * sheets, and their fields need not have focus to hold unsaved text).
 */
export function hasUnsavedInput(doc: Document = document): boolean {
  const active = doc.activeElement;
  if (active instanceof HTMLElement && (active.isContentEditable || active.matches(TEXT_ENTRY))) {
    return true;
  }
  return doc.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

export function ChunkReloadGuard() {
  useEffect(() => {
    // If we recovered earlier and the app has now been stable, clear the flag
    // so a future deploy can recover again.
    const clearTimer = setTimeout(() => {
      try {
        sessionStorage.removeItem(RELOAD_FLAG);
      } catch {
        // sessionStorage unavailable (private mode / SSR edge) — ignore.
      }
    }, 10_000);

    function recover(message: string | undefined) {
      if (!isChunkLoadError(message)) return;
      if (hasUnsavedInput()) {
        // Same id every time, so repeated chunk errors keep ONE toast up.
        toast("Cosmos has been updated", {
          id: UPDATE_TOAST_ID,
          description: "Finish what you're doing, then reload to get the new version.",
          duration: Infinity,
          action: { label: "Reload", onClick: () => window.location.reload() },
        });
        return;
      }
      try {
        if (sessionStorage.getItem(RELOAD_FLAG)) return; // already tried this interval
        sessionStorage.setItem(RELOAD_FLAG, "1");
      } catch {
        // If storage is unavailable we can't loop-guard; bail rather than risk
        // a reload loop.
        return;
      }
      window.location.reload();
    }

    function onError(e: ErrorEvent) {
      recover(e?.message || (e?.error && String(e.error)) || undefined);
    }
    function onRejection(e: PromiseRejectionEvent) {
      const r = e?.reason;
      recover(typeof r === "string" ? r : r?.message);
    }

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      clearTimeout(clearTimer);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
