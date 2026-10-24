/**
 * A stand-in for the Bot Connector and the token endpoint it needs, for tests
 * (COSMOS-202 T2). Records every request; `next` scripts the next send's
 * answer (a status and an optional Retry-After) to exercise retries.
 */
export interface SentActivity {
  url: string;
  host: string;
  conversationId: string;
  auth: string | null;
  body: Record<string, unknown>;
}

export function fakeBotConnector(opts: { loginOrigin?: string } = {}) {
  const loginOrigin = opts.loginOrigin ?? "https://login.microsoftonline.com";
  const state = {
    sent: [] as SentActivity[],
    tokenRequests: [] as { tenant: string; body: URLSearchParams }[],
    /** Every URL fetched, in order: what the code reached for. */
    urls: [] as string[],
    next: [] as { status: number; retryAfter?: string }[],
  };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    state.urls.push(url);
    const token = new RegExp(`^${loginOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+)/oauth2/v2.0/token$`).exec(url);
    if (token) {
      state.tokenRequests.push({ tenant: decodeURIComponent(token[1]), body: new URLSearchParams(String(init?.body ?? "")) });
      return Response.json({ access_token: `bot-token-${state.tokenRequests.length}`, expires_in: 3600 });
    }
    const m = /^https:\/\/([^/]+)\/.*v3\/conversations\/([^/]+)\/activities$/.exec(url);
    if (m && init?.method === "POST") {
      const scripted = state.next.shift();
      if (scripted && scripted.status >= 300) {
        return new Response("{}", { status: scripted.status, headers: scripted.retryAfter ? { "Retry-After": scripted.retryAfter } : {} });
      }
      state.sent.push({
        url, host: m[1], conversationId: decodeURIComponent(m[2]),
        auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)),
      });
      return Response.json({ id: `activity-${state.sent.length}` });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, state, texts: () => state.sent.map((s) => JSON.stringify(s.body)) };
}
