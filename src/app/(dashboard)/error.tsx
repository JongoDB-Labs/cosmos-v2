"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { reportError } from "@/lib/telemetry/error-report";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, { scope: "dashboard", digest: error.digest });
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--status-danger-bg)] text-[var(--status-danger)]">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h2 className="mb-2 text-lg font-semibold text-[var(--text)]">
          This page hit an error
        </h2>
        <p className="mb-4 text-sm text-[var(--text-muted)]">
          {error.message || "Something went wrong loading this view."}
        </p>
        {error.digest ? (
          <p className="mb-4 font-mono text-xs text-[var(--text-muted)]">
            ref: {error.digest}
          </p>
        ) : null}
        <div className="flex justify-center gap-2">
          <Button onClick={reset} variant="default" className="gap-2">
            <RotateCw className="h-4 w-4" />
            Retry
          </Button>
          <Link
            href="/"
            className={cn(buttonVariants({ variant: "ghost" }))}
          >
            Back home
          </Link>
        </div>
      </div>
    </div>
  );
}
