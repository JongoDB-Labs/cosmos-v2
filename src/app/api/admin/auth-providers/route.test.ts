// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  admin: { id: "admin-1" } as { id: string } | null,
  set: vi.fn<(provider: string, input: Record<string, unknown>, by: string) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/internal/require-system-admin", () => ({ requireSystemAdmin: async () => h.admin }));
vi.mock("@/lib/auth/provider-config", () => ({
  setProviderConfig: h.set,
  getProviderStatus: async (p: string) => ({
    configured: true,
    enabled: true,
    clientId: "00000000-0000-4000-8000-000000000001",
    tenant: p === "microsoft" ? "11111111-1111-4111-8111-111111111111" : null,
    trustedDomains: p === "microsoft" ? ["example.com"] : [],
  }),
}));

import { GET, PUT } from "./route";

const put = (body: unknown) =>
  PUT(new NextRequest("http://localhost/api/admin/auth-providers", { method: "PUT", body: JSON.stringify(body) }));
const MS = { provider: "microsoft", clientId: "00000000-0000-4000-8000-000000000001", tenant: "11111111-1111-4111-8111-111111111111" };

beforeEach(() => {
  h.admin = { id: "admin-1" };
  h.set.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("Microsoft trusted domains in Admin → Sign-in providers", () => {
  it("saves the domains, normalized", async () => {
    const res = await put({ ...MS, trustedDomains: ["Example.COM", "@corp.example"] });
    expect(res.status).toBe(200);
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.set.mock.calls[0][1]).toMatchObject({ trustedDomains: ["example.com", "corp.example"] });
  });

  it("refuses a wildcard or an address, says which, and saves nothing", async () => {
    for (const bad of ["*.example.com", "someone@example.com"]) {
      const res = await put({ ...MS, trustedDomains: ["example.com", bad] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(bad);
    }
    expect(h.set).not.toHaveBeenCalled();
  });

  it("never stores a domain list for Google", async () => {
    const res = await put({ provider: "google", clientId: "g-client", clientSecret: "g-secret", trustedDomains: ["example.com"] });
    expect(res.status).toBe(200);
    expect(h.set.mock.calls[0][1]).not.toHaveProperty("trustedDomains");
  });

  it("leaves the stored list alone when a save doesn't mention it", async () => {
    await put(MS);
    expect(h.set.mock.calls[0][1]).not.toHaveProperty("trustedDomains");
  });

  it("shows the configured list and, separately, the domains the server's environment adds", async () => {
    vi.stubEnv("MICROSOFT_TRUSTED_DOMAINS", "env.example");
    const body = (await (await GET()).json()) as {
      providers: Record<string, { trustedDomains: string[]; envTrustedDomains?: string[] }>;
    };
    expect(body.providers.microsoft.trustedDomains).toEqual(["example.com"]);
    expect(body.providers.microsoft.envTrustedDomains).toEqual(["env.example"]);
  });

  it("is for system admins only", async () => {
    h.admin = null;
    expect((await put({ ...MS, trustedDomains: ["example.com"] })).status).toBe(403);
    expect(h.set).not.toHaveBeenCalled();
  });
});
