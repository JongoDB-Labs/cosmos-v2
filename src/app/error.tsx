"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { reportError } from "@/lib/telemetry/error-report";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, { scope: "root", digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
      <div className="max-w-md text-center">
        <p className="mb-2 text-xs uppercase tracking-wider text-[var(--text-muted)]">
          Error
        </p>
        <h1 className="mb-3 text-2xl font-semibold text-[var(--text)]">
          Something went wrong
        </h1>
        <p className="mb-6 text-sm text-[var(--text-muted)]">
          {error.message ||
            "An unexpected error occurred. The error has been logged."}
        </p>
        {error.digest ? (
          <p className="mb-6 text-xs text-[var(--text-muted)]">
            Reference: <code className="font-mono">{error.digest}</code>
          </p>
        ) : null}
        <div className="flex justify-center gap-3">
          <Button onClick={reset} variant="default">
            Try again
          </Button>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-transparent px-4 py-2 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--bg-elevated)]"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
