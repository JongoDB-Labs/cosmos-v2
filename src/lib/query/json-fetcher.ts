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

  let parsedBody: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }

  if (!res.ok) {
    const msg =
      parsedBody && typeof parsedBody === "object" && "error" in parsedBody
        ? String((parsedBody as { error: unknown }).error)
        : res.statusText || `HTTP ${res.status}`;
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
