// @vitest-environment node
//
// Microsoft Graph token exchange + cache — locks the client-credentials contract:
//   - commercial vs gov: the exchange hits the CLOUD-CORRECT Entra authority + scope,
//     and graphFetch targets the cloud-correct Graph base URL;
//   - the token is CACHED per org+cloud (a 2nd call within expiry does NOT re-exchange);
//   - the token REFRESHES after it expires (or within the refresh skew);
//   - the clientSecret + the access token NEVER appear in any returned value;
//   - a missing/incomplete sealed credential ⇒ graceful "not connected", never a throw.
// Uses an INJECTED fetch (fetchImpl) so no network is touched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getOrgCredential, prisma } = vi.hoisted(() => ({
  getOrgCredential: vi.fn(),
  prisma: { integration: { findFirst: vi.fn() } },
}));

vi.mock("@/lib/integrations/credentials", () => ({ getOrgCredential }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  getGraphToken,
  graphFetch,
  _resetGraphTokenCache,
} from "./microsoft-graph";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "client-id-123";
const CLIENT_SECRET = "M365SUPERSECRET";
const TENANT_ID = "tenant-guid-456";
const ACCESS_TOKEN = "AAD-ACCESS-TOKEN-XYZ";

/** Build a fetch mock whose token endpoint returns a fresh token; Graph returns `graphBody`. */
function mockFetch(opts: {
  tokenStatus?: number;
  tokenBody?: unknown;
  graphStatus?: number;
  graphBody?: unknown;
}) {
  const tokenStatus = opts.tokenStatus ?? 200;
  const tokenBody = opts.tokenBody ?? { access_token: ACCESS_TOKEN, expires_in: 3600 };
  const graphStatus = opts.graphStatus ?? 200;
  const graphBody = opts.graphBody ?? { value: [] };
  return vi.fn().mockImplementation((url: string) => {
    const isToken = url.includes("/oauth2/v2.0/token");
    const status = isToken ? tokenStatus : graphStatus;
    const body = isToken ? tokenBody : graphBody;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetGraphTokenCache();
  // Default: org has a connected M365 credential; commercial cloud.
  getOrgCredential.mockResolvedValue({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tenantId: TENANT_ID,
  });
  prisma.integration.findFirst.mockResolvedValue({ config: { cloud: "commercial" } });
});

afterEach(() => {
  _resetGraphTokenCache();
});

describe("not connected (no / incomplete sealed credential)", () => {
  it("getGraphToken returns a graceful error and never calls fetch", async () => {
    getOrgCredential.mockResolvedValue(null);
    const fetchImpl = mockFetch({});
    const res = (await getGraphToken(ORG, { fetchImpl })) as { error?: string };
    expect(res.error).toContain("Microsoft 365 is not connected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a bundle missing clientSecret as not connected", async () => {
    getOrgCredential.mockResolvedValue({ clientId: CLIENT_ID, tenantId: TENANT_ID });
    const res = (await getGraphToken(ORG, { fetchImpl: mockFetch({}) })) as { error?: string };
    expect(res.error).toContain("not connected");
  });

  it("graphFetch surfaces the not-connected error (graceful, no throw)", async () => {
    getOrgCredential.mockResolvedValue(null);
    const res = await graphFetch(ORG, "/users", { fetchImpl: mockFetch({}) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not connected");
  });
});

describe("client-credentials exchange — commercial cloud", () => {
  it("hits login.microsoftonline.com + graph.microsoft.com/.default scope", async () => {
    const fetchImpl = mockFetch({});
    const res = (await getGraphToken(ORG, { fetchImpl })) as {
      accessToken: string;
      graphBaseUrl: string;
      cloud: string;
    };

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    );
    expect(init.method).toBe("POST");
    expect(init.body).toContain("grant_type=client_credentials");
    expect(decodeURIComponent(init.body)).toContain("scope=https://graph.microsoft.com/.default");
    expect(decodeURIComponent(init.body)).toContain(`client_id=${CLIENT_ID}`);

    expect(res.accessToken).toBe(ACCESS_TOKEN);
    expect(res.graphBaseUrl).toBe("https://graph.microsoft.com/v1.0");
    expect(res.cloud).toBe("commercial");
  });

  it("defaults to commercial when no cloud is configured", async () => {
    prisma.integration.findFirst.mockResolvedValue({ config: {} });
    const fetchImpl = mockFetch({});
    const res = (await getGraphToken(ORG, { fetchImpl })) as { cloud: string; graphBaseUrl: string };
    expect(res.cloud).toBe("commercial");
    expect(res.graphBaseUrl).toBe("https://graph.microsoft.com/v1.0");
    expect(fetchImpl.mock.calls[0][0]).toContain("login.microsoftonline.com");
  });
});

describe("client-credentials exchange — gov cloud (GCC-High)", () => {
  beforeEach(() => {
    prisma.integration.findFirst.mockResolvedValue({ config: { cloud: "gov" } });
  });

  it("hits login.microsoftonline.us + graph.microsoft.us/.default scope + .us base", async () => {
    const fetchImpl = mockFetch({});
    const res = (await getGraphToken(ORG, { fetchImpl })) as {
      accessToken: string;
      graphBaseUrl: string;
      cloud: string;
    };

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://login.microsoftonline.us/${TENANT_ID}/oauth2/v2.0/token`);
    expect(decodeURIComponent(init.body)).toContain("scope=https://graph.microsoft.us/.default");

    expect(res.graphBaseUrl).toBe("https://graph.microsoft.us/v1.0");
    expect(res.cloud).toBe("gov");
  });

  it("graphFetch targets the .us Graph base URL with the Bearer token", async () => {
    const fetchImpl = mockFetch({ graphBody: { value: [{ id: "u1" }] } });
    const res = await graphFetch(ORG, "/users", { fetchImpl });
    expect(res.ok).toBe(true);

    // The 2nd fetch call is the Graph request (1st was the token exchange).
    const [graphUrl, graphInit] = fetchImpl.mock.calls[1];
    expect(graphUrl).toBe("https://graph.microsoft.us/v1.0/users");
    expect(graphInit.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });
});

describe("token caching", () => {
  it("a 2nd getGraphToken within expiry does NOT re-exchange (one token call)", async () => {
    const fetchImpl = mockFetch({});
    await getGraphToken(ORG, { fetchImpl });
    await getGraphToken(ORG, { fetchImpl });
    const tokenCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/oauth2/v2.0/token"));
    expect(tokenCalls.length).toBe(1);
  });

  it("graphFetch reuses the cached token across two calls (one token exchange, two Graph calls)", async () => {
    const fetchImpl = mockFetch({ graphBody: { value: [] } });
    await graphFetch(ORG, "/users", { fetchImpl });
    await graphFetch(ORG, "/users/u1/messages", { fetchImpl });
    const tokenCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/oauth2/v2.0/token"));
    const graphCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes("graph.microsoft"));
    expect(tokenCalls.length).toBe(1);
    expect(graphCalls.length).toBe(2);
  });

  it("re-exchanges after the token expires (expires_in tiny ⇒ within refresh skew)", async () => {
    // expires_in:1 ⇒ expiresAt is well within the 5-min refresh skew ⇒ never served from cache.
    const fetchImpl = mockFetch({ tokenBody: { access_token: ACCESS_TOKEN, expires_in: 1 } });
    await getGraphToken(ORG, { fetchImpl });
    await getGraphToken(ORG, { fetchImpl });
    const tokenCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/oauth2/v2.0/token"));
    expect(tokenCalls.length).toBe(2);
  });

  it("commercial and gov clouds cache SEPARATELY (a cloud flip re-exchanges)", async () => {
    const fetchImpl = mockFetch({});
    // First call: commercial (the default mock).
    await getGraphToken(ORG, { fetchImpl });
    // Flip the org to gov and call again ⇒ different cache key ⇒ a 2nd exchange.
    prisma.integration.findFirst.mockResolvedValue({ config: { cloud: "gov" } });
    await getGraphToken(ORG, { fetchImpl });
    const tokenCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/oauth2/v2.0/token"));
    expect(tokenCalls.length).toBe(2);
    expect(tokenCalls[0][0]).toContain("login.microsoftonline.com");
    expect(tokenCalls[1][0]).toContain("login.microsoftonline.us");
  });
});

describe("secret / token never leak into returned values", () => {
  it("the success result carries no clientSecret", async () => {
    const res = await getGraphToken(ORG, { fetchImpl: mockFetch({}) });
    expect(JSON.stringify(res)).not.toContain(CLIENT_SECRET);
  });

  it("a token-exchange HTTP error is graceful, secret-free, and echoes only status + AADSTS code", async () => {
    const fetchImpl = mockFetch({
      tokenStatus: 401,
      tokenBody: { error: "invalid_client", error_description: "AADSTS7000215: bad secret" },
    });
    const res = (await getGraphToken(ORG, { fetchImpl })) as { error?: string };
    expect(res.error).toContain("HTTP 401");
    expect(res.error).toContain("invalid_client");
    // The clientSecret + the long error_description are NOT echoed.
    expect(res.error).not.toContain(CLIENT_SECRET);
    expect(res.error).not.toContain("bad secret");
  });

  it("a Graph API error is graceful + token-free", async () => {
    const fetchImpl = mockFetch({
      graphStatus: 403,
      graphBody: { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } },
    });
    const res = await graphFetch(ORG, "/users", { fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("HTTP 403");
      expect(res.error).toContain("Authorization_RequestDenied");
      expect(res.error).not.toContain(ACCESS_TOKEN);
    }
  });

  it("a thrown fetch (network failure) is caught → graceful error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = (await getGraphToken(ORG, { fetchImpl })) as { error?: string };
    expect(res.error).toContain("ECONNREFUSED");
  });
});
