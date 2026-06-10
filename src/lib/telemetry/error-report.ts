/**
 * Centralized error reporter. Currently logs to console and POSTs a minimal
 * payload to the audit/telemetry endpoint. When SENTRY_DSN is configured,
 * Sentry is initialized in `sentry.client.config.ts` / `sentry.server.config.ts`
 * and will pick up these errors via `Sentry.captureException` (added below
 * once @sentry/nextjs is installed).
 */
import { getBreadcrumbs } from "./breadcrumbs";

type ErrorContext = {
  scope?: string;
  digest?: string;
  url?: string;
  [key: string]: unknown;
};

export function reportError(error: Error, context: ErrorContext = {}): void {
  if (typeof window === "undefined") {
    console.error("[telemetry:error]", error.message, context, error.stack);
    return;
  }

  const w = window as typeof window & {
    Sentry?: { captureException: (e: unknown, c?: unknown) => void };
  };
  if (w.Sentry?.captureException) {
    w.Sentry.captureException(error, { extra: context });
  }

  console.error("[telemetry:error]", error.message, context, error.stack);

  try {
    void fetch("/api/v1/metrics/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        message: error.message,
        name: error.name,
        stack: error.stack?.slice(0, 4000),
        digest: context.digest,
        scope: context.scope ?? "client",
        url: context.url ?? window.location.href,
        userAgent: navigator.userAgent,
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        breadcrumbs: getBreadcrumbs(),
        ts: Date.now(),
      }),
    }).catch(() => undefined);
  } catch {
    // swallow — telemetry must never throw
  }
}
