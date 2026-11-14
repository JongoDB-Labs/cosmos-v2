export class FetchError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/**
 * What the server said went wrong, from a failed response's body: a problem's
 * `detail` (lib/openapi/problem.ts; a validation refusal puts its first issue
 * there), else the legacy `error` key. Null when the body says nothing (none,
 * plain text, a proxy's HTML page).
 */
export function serverReason(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { detail, error } = body as { detail?: unknown; error?: unknown };
  if (typeof detail === "string" && detail.trim()) return detail;
  if (typeof error === "string") return error;
  return null;
}

/** A response's body: parsed JSON when it is JSON, its text when not, null when empty. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A failed response as the FetchError jsonFetch throws, for code that calls
 * `fetch` itself:
 *
 *   if (!res.ok) throw await fetchErrorOf(res);
 *
 * Its message is the server's reason, which notifyError shows. With none, it is
 * `fallback`: empty by default, so notifyError shows the caller's own fallback.
 * Pass one where something displays `err.message` itself. It reads the body, so
 * call it before anything else does.
 */
export async function fetchErrorOf(res: Response, fallback = ""): Promise<FetchError> {
  const body = await readBody(res).catch(() => null);
  return new FetchError(res.status, body, serverReason(body) ?? fallback);
}

/**
 * fetch+JSON wrapper that throws on non-2xx so React Query treats it as an
 * error. Reads the response body as JSON when possible (and returns it via
 * FetchError.body for error UIs that want to show server-provided messages).
 */
export async function jsonFetch<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });

  const parsedBody = await readBody(res);

  if (!res.ok) {
    const msg = serverReason(parsedBody) ?? (res.statusText || `HTTP ${res.status}`);
    throw new FetchError(res.status, parsedBody, msg);
  }

  // Cosmos's `success()` helper wraps responses as `{ data: ... }`. Some
  // routes return the bare payload. Handle both shapes transparently — if
  // the body has a `data` key and no other top-level keys, unwrap it.
  if (
    parsedBody &&
    typeof parsedBody === "object" &&
    !Array.isArray(parsedBody) &&
    "data" in parsedBody &&
    Object.keys(parsedBody as object).length === 1
  ) {
    return (parsedBody as { data: T }).data;
  }
  return parsedBody as T;
}
