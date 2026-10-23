// COSMOS-202 (B2): the Graph client follows only Graph links, retries a stale
// token once, and waits as long as Microsoft's Retry-After says (capped)
// before giving up with GraphThrottled.
import { describe, it, expect, vi, beforeEach } from "vitest";

const forget = vi.fn();
vi.mock("./calendar-token.server", () => ({
  calendarAccessToken: vi.fn(async () => "at"),
  _forgetCalendarAccessToken: (...a: unknown[]) => forget(...a),
}));

import { GraphError, GraphThrottled, graphRequest, retryAfterMs } from "./graph.server";

const res = (status: number, json: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(json), { status, headers });
function script(...replies: Response[]) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: unknown) => {
    calls.push(String(url));
    return replies.shift() ?? res(500);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
beforeEach(() => forget.mockClear());

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates, caps at 30s, and defaults to 2s", () => {
    expect(retryAfterMs("5")).toBe(5000);
    expect(retryAfterMs("600")).toBe(30_000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs(null)).toBe(2000);
    expect(retryAfterMs("-3")).toBe(0);
  });
});

describe("graphRequest", () => {
  it("refuses to follow a link off the Graph host (no token sent)", async () => {
    const { fetchFn, calls } = script();
    await expect(graphRequest("o", "u", "GET", "https://evil.example/v1.0/me", undefined, { fetch: fetchFn })).rejects.toMatchObject({ code: "foreign_link" });
    expect(calls).toEqual([]);
  });

  it("asks for UTC times and sends the bearer token", async () => {
    const { fetchFn } = script(res(200, { ok: true }));
    await graphRequest("o", "u", "GET", "/me", undefined, { fetch: fetchFn });
    const init = vi.mocked(fetchFn).mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer at", Prefer: 'outlook.timezone="UTC"' });
  });

  it("retries a 401 once with a fresh token, then reports it", async () => {
    const { fetchFn, calls } = script(res(401), res(200, { id: "x" }));
    expect((await graphRequest("o", "u", "GET", "/me", undefined, { fetch: fetchFn })).data).toEqual({ id: "x" });
    expect(forget).toHaveBeenCalledWith("o", "u");
    const again = script(res(401), res(401));
    await expect(graphRequest("o", "u", "GET", "/me", undefined, { fetch: again.fetchFn })).rejects.toMatchObject({ status: 401 });
    expect(again.calls).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it("waits out Retry-After twice, then throws GraphThrottled", async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetchFn, calls } = script(res(429, {}, { "Retry-After": "4" }), res(503, {}, { "Retry-After": "1" }), res(429));
    const p = graphRequest("o", "u", "GET", "/me", undefined, { fetch: fetchFn, sleep });
    await expect(p).rejects.toBeInstanceOf(GraphThrottled);
    expect(sleep.mock.calls).toEqual([[4000], [1000]]);
    expect(calls).toHaveLength(3);
  });

  it("surfaces Graph's error code", async () => {
    const { fetchFn } = script(res(404, { error: { code: "ErrorItemNotFound" } }));
    const e = await graphRequest("o", "u", "GET", "/me/events/x", undefined, { fetch: fetchFn }).catch((x) => x);
    expect(e).toBeInstanceOf(GraphError);
    expect(e).toMatchObject({ status: 404, code: "ErrorItemNotFound" });
  });
});
