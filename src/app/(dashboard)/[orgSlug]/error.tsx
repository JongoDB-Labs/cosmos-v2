"use client";

import { useEffect, useState } from "react";
import { AlertOctagon, RotateCw, Bug } from "lucide-react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { reportError } from "@/lib/telemetry/error-report";
import { usePermissions } from "@/components/providers/permissions-provider";

export default function OrgError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams<{ orgSlug: string }>();
  // Available because this boundary renders inside the dashboard layout's
  // PermissionsProvider; falls back to "" if the error came from above it.
  const { orgId } = usePermissions();
  const [reportState, setReportState] = useState<
    "idle" | "sending" | "sent" | "failed"
  >("idle");

  useEffect(() => {
    // Fire-and-forget telemetry (metrics) — separate from the user-initiated
    // bug report below, which files a triageable FeedbackItem.
    reportError(error, {
      scope: "org",
      orgSlug: params?.orgSlug,
      digest: error.digest,
    });
  }, [error, params?.orgSlug]);

  async function fileBugReport() {
    if (!orgId) return;
    setReportState("sending");
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/feedback/report-bug`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: error.message || "Unknown workspace error",
          stack: error.stack?.slice(0, 8000),
          route:
            typeof window !== "undefined"
              ? window.location.pathname
              : undefined,
          userAgent:
            typeof navigator !== "undefined" ? navigator.userAgent : undefined,
          digest: error.digest,
        }),
      });
      if (!res.ok) throw new Error();
      setReportState("sent");
    } catch {
      setReportState("failed");
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--status-danger-bg)] text-[var(--status-danger)]">
          <AlertOctagon className="h-6 w-6" />
        </div>
        <h2 className="mb-2 text-lg font-semibold text-[var(--text)]">
          Workspace error
        </h2>
        <p className="mb-4 text-sm text-[var(--text-muted)]">
          {error.message ||
            "Something went wrong loading this workspace section."}
        </p>
        {error.digest ? (
          <p className="mb-4 font-mono text-xs text-[var(--text-muted)]">
            ref: {error.digest}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={reset} variant="default" className="gap-2">
            <RotateCw className="h-4 w-4" />
            Retry
          </Button>
          {orgId ? (
            <Button
              onClick={fileBugReport}
              variant="outline"
              disabled={reportState === "sending" || reportState === "sent"}
              className="gap-2"
            >
              <Bug className="h-4 w-4" />
              {reportState === "sent"
                ? "Reported — thanks"
                : reportState === "sending"
                  ? "Reporting…"
                  : reportState === "failed"
                    ? "Try report again"
                    : "Report this problem"}
            </Button>
          ) : null}
          {params?.orgSlug ? (
            <Link
              href={`/${params.orgSlug}`}
              className={cn(buttonVariants({ variant: "ghost" }))}
            >
              Overview
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
