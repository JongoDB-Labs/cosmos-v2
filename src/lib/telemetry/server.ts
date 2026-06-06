/**
 * Server-side error sink. Same shape as the client `reportError` so an
 * eventual Sentry wire-up can replace the body without changing call sites.
 *
 * Currently console-logs and writes nothing else; persistent storage is one
 * future option but client errors already hit /api/v1/metrics/errors, so
 * unifying via Sentry (or another OTLP sink) is the lower-cost path.
 *
 * To plug in Sentry:
 *   1. `npm install @sentry/nextjs`
 *   2. Create `sentry.server.config.ts`:
 *        import * as Sentry from "@sentry/nextjs";
 *        if (process.env.SENTRY_DSN) {
 *          Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
 *        }
 *   3. Replace the body below with `Sentry.captureException(error, { extra });`.
 */
type ServerErrorContext = {
  scope?: string;
  route?: string;
  userId?: string;
  orgId?: string;
  [key: string]: unknown;
};

export function serverReportError(
  error: unknown,
  context: ServerErrorContext = {},
): void {
  const e =
    error instanceof Error ? error : new Error(String(error ?? "unknown"));
  console.error(
    `[server:error] scope=${context.scope ?? "?"} route=${context.route ?? "?"} ` +
      `userId=${context.userId ?? "?"} msg=${e.message}`,
    e.stack ?? "",
  );

  // Hook point: if @sentry/nextjs is installed and initialized,
  // `globalThis.Sentry?.captureException` will pick this up.
  const g = globalThis as typeof globalThis & {
    Sentry?: { captureException: (e: unknown, c?: unknown) => void };
  };
  if (g.Sentry?.captureException) {
    g.Sentry.captureException(e, { extra: context });
  }
}
