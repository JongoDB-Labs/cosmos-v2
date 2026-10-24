/**
 * Which uncaught client errors the app should act on.
 *
 * Both window-level listeners (`ChunkReloadGuard`, `BugReporter`) carried their
 * own copy of the chunk-error regex; the matching rules now live here once, as
 * pure predicates that can be unit-tested without mounting a component.
 *
 * Two classes of uncaught error are NOT ours to surface:
 *
 *  - **Stale chunks after a deploy** — `ChunkReloadGuard` already recovers those
 *    with a single reload, so offering a bug report on top would file a ticket
 *    for something the app fixed itself.
 *
 *  - **Browser-extension errors** (COSMOS-172). A wallet extension such as
 *    MetaMask injects a page script that runs in the page's JS context, so when
 *    its own session restore fails ("Failed to connect to MetaMask") the
 *    rejection lands on OUR `unhandledrejection` handler and looked, to the
 *    reporter, exactly like an app crash. Cosmos has no wallet integration and
 *    never calls `connect` — the only frame in that stack is
 *    `chrome-extension://…/inpage.js`. Nothing in the app is broken and there is
 *    nothing to fix, so we swallow it: no toast, no report, and the user's page
 *    is left exactly as it was.
 */

export const CHUNK_ERROR =
  /ChunkLoadError|Loading chunk [\w./-]+ failed|Failed to load chunk|error loading dynamically imported module|Importing a module script failed|Failed to fetch dynamically imported module/i;

/**
 * A frame from a browser extension's injected content/page script:
 * `chrome-extension://`, `moz-extension://`, `safari-web-extension://`,
 * `ms-browser-extension://`. Matched on the URL scheme rather than on a list of
 * extension ids or vendor message strings, so a different wallet — or any other
 * extension that injects into the page — is covered without another patch here.
 */
const EXTENSION_FRAME = /[a-z-]+-extension:\/\//i;

/** A stack frame line: V8's `    at fn (url:1:2)` or Gecko/WebKit's `fn@url:1:2`. */
const STACK_FRAME = /^\s*at\s|@\S+:\d+:\d+\s*$/;

export function isChunkLoadError(message: string | undefined): boolean {
  return !!message && CHUNK_ERROR.test(message);
}

/**
 * Only when EVERY frame is an extension's. Extensions also wrap page APIs such
 * as `fetch`, so a genuine Cosmos error can carry an extension frame in the
 * middle of its stack; one app frame anywhere means it is ours to report.
 * With no stack to go on, an extension URL in the message decides.
 */
export function isBrowserExtensionError(
  message: string | undefined,
  stack?: string,
): boolean {
  const frames = (stack ?? "").split("\n").filter((line) => STACK_FRAME.test(line));
  if (frames.length > 0) return frames.every((line) => EXTENSION_FRAME.test(line));
  return EXTENSION_FRAME.test(message ?? "");
}

/**
 * True when an uncaught client error is worth offering the user a bug report
 * for — i.e. it plausibly came from Cosmos itself.
 */
export function isReportableClientError(
  message: string | undefined,
  stack?: string,
): message is string {
  if (!message) return false;
  if (isChunkLoadError(message)) return false;
  if (isBrowserExtensionError(message, stack)) return false;
  return true;
}
