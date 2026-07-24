"use client";

import { useEffect } from "react";

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
 */

const RELOAD_FLAG = "cosmos:chunk-reloaded";

const CHUNK_ERROR =
  /ChunkLoadError|Loading chunk [\w./-]+ failed|Failed to load chunk|error loading dynamically imported module|Importing a module script failed|Failed to fetch dynamically imported module/i;

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
      if (!message || !CHUNK_ERROR.test(message)) return;
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
