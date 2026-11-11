"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ExternalLink, LogIn, RotateCw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The outside program-management dashboard, framed. See src/lib/pm/embed.ts
 * for when this replaces the built-in page.
 *
 * Signing in cannot happen inside the frame, and that is not this page's
 * choice: Microsoft serves its sign-in page with `X-Frame-Options: DENY`
 * (measured), and Cosmos's CSP (`frame-src` names only the dashboard) refuses
 * it first. So sign-in runs in a window of its own, where Microsoft is the
 * top-level page. Someone already signed in to Microsoft (as they are if they
 * signed in to Cosmos with it) is usually through without typing anything.
 *
 * Three things keep that window from being a chore:
 *
 * - It opens by itself. The dashboard's own "Sign in" sends the frame toward
 *   Microsoft; the browser refuses and reports it to this document as a
 *   `securitypolicyviolation` on `frame-src`, the one signal a cross-origin
 *   frame gives about where it tried to go. The click that caused it was in
 *   the frame, and a click in a frame counts as activation for every document
 *   above it, so this page may open the window on that click. Without
 *   activation (the dashboard redirected on its own) it shows a prompt.
 *   The prompt carries the only Sign in button this page has: one standing
 *   beside the frame would show over a signed-in dashboard too.
 * - It goes straight to sign-in when the instance names the dashboard's
 *   sign-in start (`signInSrc`), rather than to the dashboard's sign-in page.
 * - Coming back finishes it. Nothing from another site says "sign-in is
 *   done" -- a cross-origin window exposes only `closed`, and every probe of
 *   the dashboard's session from here was measured and is refused or
 *   indistinguishable. So the person coming back to this page is the signal:
 *   the window is closed and the frame loads afresh, as it is when they
 *   close the window themselves, or return from "Open in new tab".
 */
export function EmbeddedDashboard({ src, signInSrc = src }: { src: string; signInSrc?: string }) {
  // Bumped to remount the iframe -- a cross-origin frame cannot be told to
  // reload, but a new element loads afresh.
  const [generation, setGeneration] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  // Set when the frame tried to leave for a site Cosmos will not frame, and
  // while a sign-in window is open. The frame is replaced by a prompt rather
  // than left showing the browser's broken-page icon.
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const popup = useRef<Window | null>(null);
  const openedAt = useRef(0);
  const watcher = useRef<ReturnType<typeof setInterval> | null>(null);
  // The person left to sign in somewhere this page cannot see (the prompt was
  // up, or they used Open in new tab): coming back loads the frame afresh.
  const reloadOnReturn = useRef(false);

  function stopWatching() {
    if (watcher.current) clearInterval(watcher.current);
    watcher.current = null;
  }

  function reload() {
    reloadOnReturn.current = false;
    setNeedsSignIn(false);
    setGeneration((g) => g + 1);
  }

  function finishSignIn() {
    stopWatching();
    if (popup.current && !popup.current.closed) popup.current.close();
    popup.current = null;
    setSigningIn(false);
    reload();
  }

  function signIn() {
    const w = window.open(signInSrc, "program-management-sign-in", "popup,width=520,height=720");
    // Blocked: the prompt's Sign in and "Open in new tab" are the way through.
    if (!w) {
      setNeedsSignIn(true);
      reloadOnReturn.current = true;
      return;
    }
    popup.current = w;
    openedAt.current = Date.now();
    setSigningIn(true);
    setNeedsSignIn(true);
    stopWatching();
    // `closed` is the one property of a cross-origin window we may read.
    watcher.current = setInterval(() => {
      if (popup.current?.closed) finishSignIn();
    }, 500);
  }

  const onViolation = useEffectEvent((e: SecurityPolicyViolationEvent) => {
    if (e.effectiveDirective !== "frame-src") return;
    if (popup.current && !popup.current.closed) return;
    if (navigator.userActivation?.isActive) {
      signIn();
    } else {
      setNeedsSignIn(true);
      reloadOnReturn.current = true;
    }
  });

  const onReturn = useEffectEvent(() => {
    if (document.visibilityState === "hidden") return;
    const w = popup.current;
    if (w) {
      // A browser that keeps focus here, or hands it straight back, would
      // otherwise "return" the instant the window opened and close it.
      if (!w.closed && Date.now() - openedAt.current < RETURN_GRACE_MS) return;
      finishSignIn();
      return;
    }
    if (reloadOnReturn.current) reload();
  });

  useEffect(() => {
    const violation = (e: SecurityPolicyViolationEvent) => onViolation(e);
    const back = () => onReturn();
    document.addEventListener("securitypolicyviolation", violation);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      document.removeEventListener("securitypolicyviolation", violation);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
      if (watcher.current) clearInterval(watcher.current);
    };
  }, []);

  const frameClass =
    "h-[calc(100dvh-13rem)] min-h-[32rem] w-full rounded-[var(--radius)] border border-[var(--border)]";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--text-muted)]">
        {/* Nothing here once the dashboard shows. This page cannot tell
            whether someone is signed in to another site, so a standing "Sign
            in" read as "you are signed out" to people looking at their own
            signed-in dashboard. Sign-in starts from the dashboard's own button
            (see above) or from the prompt that replaces the frame. */}
        <p className="min-w-0" aria-live="polite">
          {signingIn
            ? "Finish signing in in the other window, then come back here. The dashboard loads when you do."
            : null}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={reload}
            aria-label="Reload dashboard"
            title="Reload dashboard"
          >
            <RotateCw aria-hidden />
          </Button>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              reloadOnReturn.current = true;
            }}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
          >
            <ExternalLink aria-hidden />
            Open in new tab
          </a>
        </div>
      </div>
      {needsSignIn ? (
        <div
          role="status"
          className={cn(
            frameClass,
            "flex flex-col items-center justify-center gap-4 bg-[var(--surface)] p-6 text-center",
          )}
        >
          <div>
            <p className="font-medium text-[var(--text)]">
              {signingIn ? "Signing in…" : "Sign in to see the dashboard"}
            </p>
            <p className="mt-1 max-w-md text-sm text-[var(--text-muted)]">
              {signingIn
                ? "Microsoft's sign-in is open in its own window. When you're done, come back to this page and the dashboard loads here."
                : "Microsoft's sign-in opens in its own window. When you're done, come back to this page and the dashboard loads here. If it still asks you to sign in, use Open in new tab."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={signIn}>
              <LogIn aria-hidden />
              Sign in
            </Button>
            <Button variant="ghost" onClick={signingIn ? finishSignIn : reload}>
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <iframe
          key={generation}
          src={src}
          title="Program management dashboard"
          className={cn(frameClass, "bg-[var(--surface)]")}
          // Everything the dashboard needs to work as a page, and nothing that
          // lets it act on Cosmos: no top navigation, so it cannot send the
          // whole tab somewhere else.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      )}
    </div>
  );
}

/** How long after the window opens a "return" to this page is ignored. */
const RETURN_GRACE_MS = 1000;
