// COSMOS-202 T2: Cosmos writing to Teams. Only Microsoft's commercial Bot
// Connector host (exact, or a dot-suffix subdomain: never a substring), over
// https, re-checked on every send, never following a redirect; a cached
// client-credentials token; Teams' Retry-After honoured.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBotConnector } from "@/lib/testing/fake-bot-connector";

vi.mock("@/lib/auth/provider-config", () => ({
  getProviderConfig: async () => ({ clientId: "bot-app-id", clientSecret: "bot-app-secret" }),
}));

const { isAllowedServiceUrl, sendToConversation, ConnectorError, _resetBotTokens } = await import("./bot-connector.server");

const REF = { tenantId: "tenant-1", serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "a:1:personal" };

describe("Bot Connector allowlist", () => {
  it("allows the commercial host, exactly or as a dot-suffix subdomain, over https", () => {
    for (const ok of ["https://smba.trafficmanager.net/amer/", "https://smba.trafficmanager.net/", "https://emea.smba.trafficmanager.net/x/", "https://SMBA.TrafficManager.net/amer/"]) {
      expect(isAllowedServiceUrl(ok), ok).toBe(true);
    }
  });

  it("refuses look-alikes, other schemes, ports, userinfo, and the government clouds", () => {
    for (const bad of [
      "http://smba.trafficmanager.net/amer/",
      "https://smba.trafficmanager.net.evil.example/amer/",
      "https://evilsmba.trafficmanager.net/amer/",
      "https://evil.example/smba.trafficmanager.net/",
      "https://smba.trafficmanager.net:8443/amer/",
      "https://user:pw@smba.trafficmanager.net/amer/",
      "https://smba.infra.gcc.teams.microsoft.com/gcch/", // GCC High
      "https://smba.infra.dod.teams.microsoft.us/dod/", // DoD
      "not a url",
      undefined,
      42,
    ]) {
      expect(isAllowedServiceUrl(bad), String(bad)).toBe(false);
    }
  });
});

describe("sendToConversation", () => {
  beforeEach(() => _resetBotTokens());

  it("posts the activity with a bot token from the org's tenant, never following a redirect", async () => {
    const f = fakeBotConnector();
    const spy = vi.fn(f.fetch);
    await sendToConversation(REF, { text: "hi" }, { fetch: spy });
    expect(f.state.tokenRequests).toHaveLength(1);
    expect(f.state.tokenRequests[0].tenant).toBe("tenant-1");
    expect(Object.fromEntries(f.state.tokenRequests[0].body)).toMatchObject({ grant_type: "client_credentials", client_id: "bot-app-id", scope: "https://api.botframework.com/.default" });
    expect(f.state.sent).toEqual([expect.objectContaining({ host: "smba.trafficmanager.net", conversationId: "a:1:personal", auth: "Bearer bot-token-1", body: { type: "message", text: "hi" } })]);
    for (const call of spy.mock.calls) expect((call[1] as RequestInit).redirect).toBe("error");
  });

  it("re-checks the allowlist at send: a stored reference that isn't allowed is never fetched", async () => {
    const f = fakeBotConnector();
    await expect(sendToConversation({ ...REF, serviceUrl: "https://evil.example/" }, { text: "hi" }, { fetch: f.fetch })).rejects.toBeInstanceOf(ConnectorError);
    expect(f.state.urls).toEqual([]);
  });

  it("caches the token until shortly before it expires; a 401 drops it", async () => {
    const f = fakeBotConnector();
    let t = 1_000_000;
    const deps = { fetch: f.fetch, now: () => t };
    await sendToConversation(REF, { text: "1" }, deps);
    await sendToConversation(REF, { text: "2" }, deps);
    expect(f.state.tokenRequests).toHaveLength(1);
    t += 56 * 60_000; // inside the 5-minute early window
    await sendToConversation(REF, { text: "3" }, deps);
    expect(f.state.tokenRequests).toHaveLength(2);
    f.state.next.push({ status: 401 });
    await expect(sendToConversation(REF, { text: "4" }, deps)).rejects.toMatchObject({ status: 401 });
    await sendToConversation(REF, { text: "5" }, deps);
    expect(f.state.tokenRequests).toHaveLength(3);
  });

  it("reports Retry-After on a 429, and 403/404 as the bot being gone", async () => {
    const f = fakeBotConnector();
    f.state.next.push({ status: 429, retryAfter: "120" }, { status: 403 }, { status: 503 });
    const e1 = await sendToConversation(REF, {}, { fetch: f.fetch }).catch((e) => e);
    expect([e1.status, e1.retryAfterMs, e1.retryable, e1.gone]).toEqual([429, 120_000, true, false]);
    const e2 = await sendToConversation(REF, {}, { fetch: f.fetch }).catch((e) => e);
    expect([e2.gone, e2.retryable]).toEqual([true, false]);
    const e3 = await sendToConversation(REF, {}, { fetch: f.fetch }).catch((e) => e);
    expect([e3.retryAfterMs, e3.retryable]).toEqual([null, true]);
  });
});
