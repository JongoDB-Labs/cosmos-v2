"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { reportError } from "@/lib/telemetry/error-report";

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, { scope: "settings", digest: error.digest });
  }, [error]);

  return (
    <div className="p-6">
      <div className="rounded-[var(--radius-md)] border border-[var(--status-danger)]/30 bg-[var(--status-danger-bg)]/40 p-4">
        <p className="mb-1 text-sm font-medium text-[var(--text)]">
          Settings section failed to load
        </p>
        <p className="mb-3 text-xs text-[var(--text-muted)]">
          {error.message || "An unexpected error occurred."}
        </p>
        <Button onClick={reset} variant="outline" size="sm">
          Retry
        </Button>
      </div>
    </div>
  );
}
