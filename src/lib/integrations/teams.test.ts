import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the sealed-credential + prisma seams so the client is exercised with no
// DB / network — only the injected fetch runs.
const getOrgCredential = vi.fn();
vi.mock("@/lib/integrations/credentials", () => ({
  getOrgCredential: (...a: unknown[]) => getOrgCredential(...a),
}));
const findFirst = vi.fn();
vi.mock("@/lib/db/client", () => ({
  prisma: { integration: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

import { postTeamsChannelMessage, testTeamsConnection } from "./teams";

type Call = { url: string; init?: { method?: string; body?: string } };

/** Build an injectable fetch that returns a token then a post response. */
function fakeFetch(responses: Array<{ ok: boolean; status?: number; json?: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? {}),
    };
  };
  return { fetchImpl, calls };
}

const GOOD_CRED = { clientId: "cid", clientSecret: "sec", tenantId: "tid" };

beforeEach(() => {
  getOrgCredential.mockReset();
  findFirst.mockReset();
});

describe("teams client — credential gating", () => {
  it("graceful not-connected error when no credential", async () => {
    getOrgCredential.mockResolvedValue(null);
    const r = await testTeamsConnection("org1", { fetchImpl: fakeFetch([]).fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not connected/i);
  });

  it("not-connected when the bundle is missing a field", async () => {
    getOrgCredential.mockResolvedValue({ clientId: "x", tenantId: "y" }); // no secret
    const r = await testTeamsConnection("org1", { fetchImpl: fakeFetch([]).fetchImpl });
    expect(r.ok).toBe(false);
  });
});

describe("teams client — token exchange", () => {
  it("testTeamsConnection succeeds when the token endpoint returns a token", async () => {
    getOrgCredential.mockResolvedValue(GOOD_CRED);
    findFirst.mockResolvedValue({ config: {} });
    const { fetchImpl, calls } = fakeFetch([{ ok: true, json: { access_token: "tok" } }]);
    const r = await testTeamsConnection("org1", { fetchImpl });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain("login.microsoftonline.com"); // commercial default
  });

  it("uses the gov authority when cloud=gov", async () => {
    getOrgCredential.mockResolvedValue(GOOD_CRED);
    findFirst.mockResolvedValue({ config: { cloud: "gov" } });
    const { fetchImpl, calls } = fakeFetch([{ ok: true, json: { access_token: "tok" } }]);
    await testTeamsConnection("org1", { fetchImpl });
    expect(calls[0].url).toContain("login.microsoftonline.us");
  });

  it("surfaces a token error without leaking the secret", async () => {
    getOrgCredential.mockResolvedValue(GOOD_CRED);
    findFirst.mockResolvedValue({ config: {} });
    const { fetchImpl } = fakeFetch([{ ok: false, status: 401, json: { error: "invalid_client" } }]);
    const r = await testTeamsConnection("org1", { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/invalid_client/);
      expect(r.error).not.toContain("sec"); // the secret never appears
    }
  });
});

describe("teams client — posting", () => {
  it("posts to the configured default channel (token then message)", async () => {
    getOrgCredential.mockResolvedValue(GOOD_CRED);
    findFirst.mockResolvedValue({ config: { defaultTeamId: "T1", defaultChannelId: "C1" } });
    const { fetchImpl, calls } = fakeFetch([
      { ok: true, json: { access_token: "tok" } },
      { ok: true, status: 201, json: { id: "msg1" } },
    ]);
    const r = await postTeamsChannelMessage("org1", { html: "<b>hi</b>" }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("/teams/T1/channels/C1/messages");
    expect(calls[1].init?.method).toBe("POST");
    expect(calls[1].init?.body).toContain("<b>hi</b>");
  });

  it("errors when no channel is configured and none passed", async () => {
    getOrgCredential.mockResolvedValue(GOOD_CRED);
    findFirst.mockResolvedValue({ config: {} });
    const { fetchImpl, calls } = fakeFetch([{ ok: true, json: { access_token: "tok" } }]);
    const r = await postTeamsChannelMessage("org1", { html: "x" }, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no teams channel/i);
    expect(calls).toHaveLength(0); // fails before any network
  });

  it("explicit team/channel override the defaults", async () => {
    getOrgCredential.mockResolvedValue(GOOD_CRED);
    findFirst.mockResolvedValue({ config: { defaultTeamId: "T1", defaultChannelId: "C1" } });
    const { fetchImpl, calls } = fakeFetch([
      { ok: true, json: { access_token: "tok" } },
      { ok: true, status: 201, json: {} },
    ]);
    await postTeamsChannelMessage("org1", { html: "x", teamId: "T9", channelId: "C9" }, { fetchImpl });
    expect(calls[1].url).toContain("/teams/T9/channels/C9/messages");
  });
});
