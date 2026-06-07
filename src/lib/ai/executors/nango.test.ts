// @vitest-environment node
//
// Nango EXECUTOR — D5 gov-block LAYER 3 (the executor's own hard gate) + the
// commercial happy path. The in-boundary wrapper (@/lib/integrations/nango) is fully
// mocked — no network, no broker. Proves:
//   - L3: a gov (or class-absent) ctx is REFUSED at the TOP, BEFORE any wrapper call;
//   - commercial: each tool forwards ORG-SCOPED to the right wrapper helper;
//   - graceful "not configured" when nangoEnabled() is false;
//   - required-arg validation; unknown name → null.
import { describe, it, expect, vi, beforeEach } from "vitest";

const wrapper = vi.hoisted(() => ({
  nangoEnabled: vi.fn(),
  listConnections: vi.fn(),
  getConnection: vi.fn(),
  nangoProxy: vi.fn(),
}));
vi.mock("@/lib/integrations/nango", () => wrapper);

import { executeNangoTool, NANGO_TOOL_NAMES } from "./nango";

const ORG = "org-1";
const USER = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
  wrapper.nangoEnabled.mockReturnValue(true);
});

describe("L3 — executor hard-refuses a gov (or class-absent) tenant BEFORE any wrapper call", () => {
  it("refuses every nango tool for a gov ctx, never touching the wrapper", async () => {
    for (const name of NANGO_TOOL_NAMES) {
      const res = (await executeNangoTool(name, { provider: "hubspot", endpoint: "/x" }, { orgId: ORG, userId: USER, tenantClass: "gov" })) as { error?: string };
      expect(res.error).toMatch(/commercial-only|not available/i);
    }
    expect(wrapper.listConnections).not.toHaveBeenCalled();
    expect(wrapper.getConnection).not.toHaveBeenCalled();
    expect(wrapper.nangoProxy).not.toHaveBeenCalled();
    expect(wrapper.nangoEnabled).not.toHaveBeenCalled(); // refused before the enabled check too
  });

  it("FAIL-CLOSED: refuses when tenantClass is ABSENT", async () => {
    const res = (await executeNangoTool("nango_list_connections", {}, { orgId: ORG, userId: USER })) as { error?: string };
    expect(res.error).toMatch(/commercial-only|not available/i);
    expect(wrapper.listConnections).not.toHaveBeenCalled();
  });
});

describe("commercial path — forwards org-scoped to the wrapper", () => {
  const commCtx = { orgId: ORG, userId: USER, tenantClass: "commercial" as const };

  it("nango_list_connections → listConnections(orgId)", async () => {
    wrapper.listConnections.mockResolvedValue({ connections: [] });
    await executeNangoTool("nango_list_connections", {}, commCtx);
    expect(wrapper.listConnections).toHaveBeenCalledWith(ORG);
  });

  it("nango_get_connection → getConnection(orgId, provider); requires provider", async () => {
    wrapper.getConnection.mockResolvedValue({ connection_id: "x" });
    await executeNangoTool("nango_get_connection", { provider: "hubspot" }, commCtx);
    expect(wrapper.getConnection).toHaveBeenCalledWith(ORG, "hubspot");

    const missing = (await executeNangoTool("nango_get_connection", {}, commCtx)) as { error?: string };
    expect(missing.error).toMatch(/provider is required/i);
  });

  it("nango_proxy_request → nangoProxy(orgId, provider, {method, endpoint, params, data})", async () => {
    wrapper.nangoProxy.mockResolvedValue({ success: true, status: 200, data: { items: [] } });
    await executeNangoTool(
      "nango_proxy_request",
      { provider: "hubspot", endpoint: "/v3/objects/contacts", method: "get", params: { limit: 5 }, data: { a: 1 } },
      commCtx,
    );
    expect(wrapper.nangoProxy).toHaveBeenCalledWith(ORG, "hubspot", {
      method: "GET",
      endpoint: "/v3/objects/contacts",
      params: { limit: 5 },
      data: { a: 1 },
    });
  });

  it("nango_proxy_request validates provider + endpoint", async () => {
    expect(((await executeNangoTool("nango_proxy_request", { endpoint: "/x" }, commCtx)) as { error?: string }).error).toMatch(/provider is required/i);
    expect(((await executeNangoTool("nango_proxy_request", { provider: "hubspot" }, commCtx)) as { error?: string }).error).toMatch(/endpoint is required/i);
    expect(wrapper.nangoProxy).not.toHaveBeenCalled();
  });

  it("graceful 'not configured' when Nango is disabled (commercial)", async () => {
    wrapper.nangoEnabled.mockReturnValue(false);
    const res = (await executeNangoTool("nango_list_connections", {}, commCtx)) as { error?: string };
    expect(res.error).toMatch(/not configured/i);
    expect(wrapper.listConnections).not.toHaveBeenCalled();
  });

  it("unknown tool name → null (not a nango tool)", async () => {
    expect(await executeNangoTool("totally_unknown", {}, commCtx)).toBeNull();
  });
});
