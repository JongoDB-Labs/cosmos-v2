"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, LogIn, RotateCw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The outside program-management dashboard, framed. See src/lib/pm/embed.ts
 * for when this replaces the built-in page.
 *
 * Signing in cannot happen inside the frame. The dashboard's own "Sign in"
 * sends the frame to Microsoft, and Cosmos's CSP (`frame-src` names only the
 * dashboard) refuses that, as Microsoft itself would: its sign-in page will
 * not be framed by another site. Left alone, that ends on the browser's
 * broken-page icon. So sign-in runs in a window of its own, where Microsoft is
 * the top-level page. Someone already signed in to Microsoft (as they are if
 * they signed in to Cosmos with it) is usually through without typing
 * anything. When that window closes, the frame reloads to pick up the session.
 *
 * The refusal is also how this page knows to ask: the browser reports it to
 * this document as a `securitypolicyviolation` on `frame-src`, which is the
 * one signal a cross-origin frame gives about where it tried to go.
 *
 * "Open in new tab" is the way out that always works, whatever the browser's
 * cookie rules make of a dashboard on another site.
 */
export function EmbeddedDashboard({ src }: { src: string }) {
  // Bumped to remount the iframe -- a cross-origin frame cannot be told to
  // reload, but a new element loads afresh.
  const [generation, setGeneration] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  // Set when the frame tried to leave for a site Cosmos will not frame. The
  // frame is replaced by a prompt rather than left showing the broken page.
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const watcher = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function onViolation(e: SecurityPolicyViolationEvent) {
      if (e.effectiveDirective === "frame-src") setNeedsSignIn(true);
    }
    document.addEventListener("securitypolicyviolation", onViolation);
    return () => {
      document.removeEventListener("securitypolicyviolation", onViolation);
      if (watcher.current) clearInterval(watcher.current);
    };
  }, []);

  function reload() {
    setNeedsSignIn(false);
    setGeneration((g) => g + 1);
  }

  function signIn() {
    const popup = window.open(src, "program-management-sign-in", "popup,width=520,height=720");
    // Blocked: "Open in new tab" beside this button is the way through, so
    // there is nothing to watch.
    if (!popup) return;
    setSigningIn(true);
    if (watcher.current) clearInterval(watcher.current);
    // `closed` is the one property of a cross-origin window we may read. There
    // is no "sign-in finished" event to listen for from another site.
    watcher.current = setInterval(() => {
      if (!popup.closed) return;
      if (watcher.current) clearInterval(watcher.current);
      watcher.current = null;
      setSigningIn(false);
      reload();
    }, 500);
  }

  const frameClass =
    "h-[calc(100dvh-13rem)] min-h-[32rem] w-full rounded-[var(--radius)] border border-[var(--border)]";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--text-muted)]">
        <p className="min-w-0" aria-live="polite">
          {signingIn
            ? "Finish signing in in the other window, then close it. This page reloads when you do."
            : "If the dashboard asks you to sign in, use Sign in here. Microsoft's sign-in can't open inside this page."}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={signIn}>
            <LogIn aria-hidden />
            Sign in
          </Button>
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
            <p className="font-medium text-[var(--text)]">Sign in to see the dashboard</p>
            <p className="mt-1 max-w-md text-sm text-[var(--text-muted)]">
              Microsoft&apos;s sign-in opens in its own window. Close that window when you&apos;re
              done and the dashboard loads here. If it still asks you to sign in, use Open in
              new tab.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={signIn}>
              <LogIn aria-hidden />
              Sign in
            </Button>
            <Button variant="ghost" onClick={reload}>
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
