// @vitest-environment node
//
// The auth gate and the status contract. A scheduler reads the status code
// before it reads the body, so 200-vs-207 is load-bearing: it is the difference
// between "nothing to do" and "a rule has been broken since March".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";

const { resolveAuth, prisma, runOrgRules } = vi.hoisted(() => ({
  resolveAuth: vi.fn(),
  prisma: { organization: { findUnique: vi.fn() } },
  runOrgRules: vi.fn(),
}));
vi.mock("@/lib/auth/api-key", () => ({ resolveAuth }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rules/run", () => ({ runOrgRules }));

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = { params: Promise.resolve({ orgId: ORG_ID }) };
const req = () => new NextRequest("http://localhost/api/v1/orgs/x/rules/run", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID });
  resolveAuth.mockResolvedValue({ orgId: ORG_ID, userId: "u1", permissions: Permission.RULES_RUN });
  runOrgRules.mockResolvedValue({ ok: true, plugins: [] });
});

describe("POST /rules/run", () => {
  it("404s for an org that does not exist, before touching auth", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(404);
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it("401s when the token does not resolve", async () => {
    resolveAuth.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(401);
    expect(runOrgRules).not.toHaveBeenCalled();
  });

  it("403s without RULES_RUN, and runs nothing", async () => {
    // The run has side effects -- flags, notifications -- so a read-only key
    // must not be able to fire it.
    resolveAuth.mockResolvedValue({ orgId: ORG_ID, userId: "u1", permissions: Permission.ITEM_READ });
    expect((await POST(req(), params)).status).toBe(403);
    expect(runOrgRules).not.toHaveBeenCalled();
  });

  it("200s on a clean run", async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plugins: [] });
    expect(runOrgRules).toHaveBeenCalledWith(ORG_ID);
  });

  it("207s when a plugin failed, and still returns the detail", async () => {
    // NOT 500: the other plugins did run, and the caller needs to know which
    // one broke. A blanket 500 would say only "something, somewhere".
    runOrgRules.mockResolvedValue({
      ok: false,
      plugins: [{ slug: "a", ok: false, error: "kaboom" }],
    });
    const res = await POST(req(), params);
    expect(res.status).toBe(207);
    expect((await res.json()).plugins[0]).toMatchObject({ slug: "a", error: "kaboom" });
  });
});
