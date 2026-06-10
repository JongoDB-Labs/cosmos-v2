"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { usePermissions } from "@/components/providers/permissions-provider";
import { initBreadcrumbs, getBreadcrumbs } from "@/lib/telemetry/breadcrumbs";

/**
 * Turns an UNCAUGHT client error (window error / unhandledrejection) into a
 * one-click bug report. Render-time errors that trip a React error boundary are
 * handled by the boundary's own "Report this problem" button (error.tsx); this
 * catches the rest — event-handler throws and rejected promises that never
 * reach a boundary. On a fresh error it offers a toast with a "Report" action
 * that files a deduped BUG FeedbackItem via /feedback/report-bug.
 *
 * Mounted inside the dashboard's PermissionsProvider so it has the current
 * org id. Chunk-load errors are excluded — ChunkReloadGuard recovers those.
 */

const CHUNK_ERROR =
  /ChunkLoadError|Loading chunk [\w./-]+ failed|Failed to load chunk|error loading dynamically imported module|Importing a module script failed|Failed to fetch dynamically imported module/i;

// Module-level so a given error signature is offered at most once per page load
// (survives re-subscribes when the active org changes).
const offered = new Set<string>();

export function BugReporter() {
  const { orgId } = usePermissions();

  useEffect(() => {
    function offer(message: string | undefined, stack?: string) {
      if (!message || CHUNK_ERROR.test(message)) return;
      const sig = message.split("\n")[0].slice(0, 160);
      if (offered.has(sig)) return;
      offered.add(sig);
      if (!orgId) return; // outside an org context — nothing to report to

      toast.error("Something went wrong", {
        description: "Help us fix it — send a one-click bug report?",
        duration: 12_000,
        action: {
          label: "Report",
          onClick: async () => {
            try {
              const res = await fetch(
                `/api/v1/orgs/${orgId}/feedback/report-bug`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    message: message.slice(0, 2000),
                    stack: stack?.slice(0, 8000),
                    route: window.location.pathname,
                    userAgent: navigator.userAgent,
                    appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
                    viewport: `${window.innerWidth}x${window.innerHeight}`,
                    breadcrumbs: getBreadcrumbs(),
                  }),
                },
              );
              if (!res.ok) throw new Error();
              toast.success("Thanks — your report was filed.");
            } catch {
              toast.error("Couldn't send the report. Please try again.");
            }
          },
        },
      });
    }

    function onError(e: ErrorEvent) {
      offer(e?.message || (e?.error && String(e.error)) || undefined, e?.error?.stack);
    }
    function onRejection(e: PromiseRejectionEvent) {
      const r = e?.reason;
      offer(typeof r === "string" ? r : r?.message, r?.stack);
    }

    // Start recording console breadcrumbs so a later report carries the
    // messages that led up to the error (React logs render errors via
    // console.error before they surface).
    initBreadcrumbs();
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [orgId]);

  return null;
}
