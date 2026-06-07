// @vitest-environment node
//
// Nango wrapper contract — locks the in-boundary client door:
//   - DISABLED when unconfigured (no NANGO_SECRET_KEY / NANGO_HOST) → every helper
//     returns a graceful shape and NEVER constructs the SDK (no accidental egress);
//   - org-scoped connection ids are DERIVED from the org id (never the caller) so one
//     org can never address another org's connection;
//   - proxy/getConnection/listConnections pass the org-scoped id through to the SDK;
//   - the secret key is read from env and passed to the SDK, never logged.
// The @nangohq/node SDK is fully mocked — no network, no server.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// One shared mock Nango instance the constructor returns, so tests can assert on
// the exact args the wrapper forwards to the SDK.
const nangoInstance = vi.hoisted(() => ({
  createConnectSession: vi.fn(),
  listConnections: vi.fn(),
  getConnection: vi.fn(),
  getToken: vi.fn(),
  proxy: vi.fn(),
}));
const NangoCtor = vi.hoisted(() => vi.fn());

vi.mock("@nangohq/node", () => ({
  Nango: class {
    constructor(...args: unknown[]) {
      NangoCtor(...args);
      return nangoInstance as unknown as object;
    }
  },
}));

import {
  nangoEnabled,
  nangoConnectionId,
  createConnectSession,
  listConnections,
  getConnection,
  getNangoToken,
  nangoProxy,
} from "./nango";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";

const SAVED = { key: process.env.NANGO_SECRET_KEY, host: process.env.NANGO_HOST };

function enable() {
  process.env.NANGO_SECRET_KEY = "nango-test-secret";
  process.env.NANGO_HOST = "http://nango-server:3003";
}
function disable() {
  delete process.env.NANGO_SECRET_KEY;
  delete process.env.NANGO_HOST;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  // Restore the original env so other tests aren't affected.
  if (SAVED.key === undefined) delete process.env.NANGO_SECRET_KEY;
  else process.env.NANGO_SECRET_KEY = SAVED.key;
  if (SAVED.host === undefined) delete process.env.NANGO_HOST;
  else process.env.NANGO_HOST = SAVED.host;
});

describe("nangoEnabled", () => {
  it("is false when the secret key OR host is missing", () => {
    disable();
    expect(nangoEnabled()).toBe(false);
    process.env.NANGO_SECRET_KEY = "x";
    expect(nangoEnabled()).toBe(false); // host still missing
    delete process.env.NANGO_SECRET_KEY;
    process.env.NANGO_HOST = "http://nango-server:3003";
    expect(nangoEnabled()).toBe(false); // key still missing
  });
  it("is true only when both are set", () => {
    enable();
    expect(nangoEnabled()).toBe(true);
  });
});

describe("nangoConnectionId (org-scoping)", () => {
  it("derives a per-org id, with optional per-provider namespace", () => {
    expect(nangoConnectionId(ORG)).toBe(ORG);
    expect(nangoConnectionId(ORG, "hubspot")).toBe(`${ORG}:hubspot`);
  });
  it("never collides across orgs for the same provider", () => {
    expect(nangoConnectionId(ORG, "hubspot")).not.toBe(nangoConnectionId(OTHER_ORG, "hubspot"));
  });
  it("requires an org id", () => {
    expect(() => nangoConnectionId("")).toThrow(/orgId is required/);
  });
});

describe("disabled when unconfigured (no SDK constructed, graceful shape)", () => {
  beforeEach(() => disable());

  it("createConnectSession returns a not-configured error and never builds the SDK", async () => {
    const res = (await createConnectSession(ORG, "hubspot")) as { error?: string };
    expect(res.error).toMatch(/not configured/i);
    expect(NangoCtor).not.toHaveBeenCalled();
  });
  it("listConnections / getConnection / nangoProxy return graceful, SDK untouched", async () => {
    expect((await listConnections(ORG) as { error?: string }).error).toMatch(/not configured/i);
    expect((await getConnection(ORG, "hubspot") as { error?: string }).error).toMatch(/not configured/i);
    expect((await nangoProxy(ORG, "hubspot", { endpoint: "/x" }) as { error?: string }).error).toMatch(/not configured/i);
    expect(NangoCtor).not.toHaveBeenCalled();
  });
  it("getNangoToken returns null when disabled", async () => {
    expect(await getNangoToken(ORG, "hubspot")).toBeNull();
    expect(NangoCtor).not.toHaveBeenCalled();
  });
});

describe("enabled: forwards org-scoped ids to the SDK; never logs the key", () => {
  beforeEach(() => enable());

  it("constructs the SDK with the env secret key + internal host", async () => {
    nangoInstance.listConnections.mockResolvedValue({ connections: [] });
    await listConnections(ORG);
    expect(NangoCtor).toHaveBeenCalledWith({ secretKey: "nango-test-secret", host: "http://nango-server:3003" });
  });

  it("createConnectSession binds the org-scoped end_user id + org tag + the provider", async () => {
    nangoInstance.createConnectSession.mockResolvedValue({ data: { token: "sess-tok" } });
    await createConnectSession(ORG, "hubspot");
    expect(nangoInstance.createConnectSession).toHaveBeenCalledWith({
      end_user: { id: `${ORG}:hubspot`, tags: { organization_id: ORG } },
      allowed_integrations: ["hubspot"],
    });
  });

  it("listConnections searches by the org id (this org's connections only)", async () => {
    nangoInstance.listConnections.mockResolvedValue({ connections: [] });
    await listConnections(ORG);
    expect(nangoInstance.listConnections).toHaveBeenCalledWith(undefined, ORG);
  });

  it("getConnection uses the org-scoped connection id", async () => {
    nangoInstance.getConnection.mockResolvedValue({ connection_id: `${ORG}:hubspot` });
    await getConnection(ORG, "hubspot");
    expect(nangoInstance.getConnection).toHaveBeenCalledWith("hubspot", `${ORG}:hubspot`);
  });

  it("getConnection returns a graceful 'not connected' on SDK error (no raw error leak)", async () => {
    nangoInstance.getConnection.mockRejectedValue(new Error("404 with host detail"));
    const res = (await getConnection(ORG, "hubspot")) as { error?: string };
    expect(res.error).toMatch(/not connected/i);
    expect(res.error).not.toMatch(/host detail/);
  });

  it("nangoProxy passes through method/endpoint/params under the org-scoped connection id; returns body only", async () => {
    nangoInstance.proxy.mockResolvedValue({ status: 200, data: { items: [{ id: "1" }] }, config: { headers: { secret: "X" } } });
    const res = (await nangoProxy(ORG, "hubspot", { method: "GET", endpoint: "/v3/objects/contacts", params: { limit: 5 } })) as {
      success?: boolean; status?: number; data?: unknown;
    };
    expect(nangoInstance.proxy).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/v3/objects/contacts",
      providerConfigKey: "hubspot",
      connectionId: `${ORG}:hubspot`,
      params: { limit: 5 },
      data: undefined,
      headers: undefined,
    });
    // Body only — the axios `config` (which can echo headers) is NOT returned.
    expect(res).toEqual({ success: true, status: 200, data: { items: [{ id: "1" }] } });
  });

  it("nangoProxy defaults to GET and returns a secret-free error on failure", async () => {
    nangoInstance.proxy.mockRejectedValue({ response: { status: 500 }, config: { headers: { Authorization: "Bearer SECRET" } } });
    const res = (await nangoProxy(ORG, "hubspot", { endpoint: "/v3/objects/contacts" })) as { error?: string };
    expect(nangoInstance.proxy).toHaveBeenCalledWith(expect.objectContaining({ method: "GET" }));
    expect(res.error).toMatch(/failed \(HTTP 500\)/);
    expect(JSON.stringify(res)).not.toMatch(/SECRET/);
  });

  it("getNangoToken returns the string token, null on non-string / error", async () => {
    nangoInstance.getToken.mockResolvedValue("tok-123");
    expect(await getNangoToken(ORG, "hubspot")).toBe("tok-123");
    nangoInstance.getToken.mockResolvedValue({ type: "OAUTH2" });
    expect(await getNangoToken(ORG, "hubspot")).toBeNull();
    nangoInstance.getToken.mockRejectedValue(new Error("boom"));
    expect(await getNangoToken(ORG, "hubspot")).toBeNull();
  });
});
