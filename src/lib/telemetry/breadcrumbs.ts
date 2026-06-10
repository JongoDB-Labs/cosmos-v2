/**
 * Client-side breadcrumb ring buffer for bug-report context.
 *
 * Patches `console.error` / `console.warn` to record a bounded history of the
 * most recent messages. When an uncaught error is reported (BugReporter) or an
 * error boundary trips (reportError), we attach these breadcrumbs so triage can
 * see what led up to the failure — React logs render errors (e.g. "Cannot read
 * properties of undefined (reading 'length')") through `console.error` BEFORE
 * the error surfaces, so the breadcrumb that precedes the crash usually names
 * the real culprit.
 *
 * Mirrors what Sentry's console integration does, kept minimal and dependency
 * -free. The patch is installed once, is fully guarded (never throws, never
 * recurses — it always calls through to the original), and is a no-op on the
 * server.
 */

type Crumb = { t: number; level: "error" | "warn"; msg: string };

const MAX = 15;
const buffer: Crumb[] = [];
let installed = false;

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/**
 * Install the console patch (idempotent, client-only). Safe to call from any
 * client component's mount effect.
 */
export function initBreadcrumbs(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  (["error", "warn"] as const).forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        const msg = args.map(stringifyArg).join(" ").slice(0, 300);
        buffer.push({ t: Date.now(), level, msg });
        if (buffer.length > MAX) buffer.shift();
      } catch {
        // Breadcrumb capture must never break logging.
      }
      original(...args);
    };
  });
}

/**
 * Snapshot the breadcrumbs as compact, human-readable lines with a relative
 * timestamp (seconds before "now"), oldest first. Bounded for payload safety.
 */
export function getBreadcrumbs(): string[] {
  const now = Date.now();
  return buffer.map(
    (c) => `${((c.t - now) / 1000).toFixed(1)}s ${c.level}: ${c.msg}`,
  );
}
