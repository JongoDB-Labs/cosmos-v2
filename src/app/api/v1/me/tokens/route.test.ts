// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  authorization: null as string | null,
  getCurrentUser: vi.fn(),
  getAuthContext: vi.fn(),
  logAudit: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findMany: vi.fn() },
    apiKey: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(h.authorization ? { authorization: h.authorization } : {}) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: h.getCurrentUser, getAuthContext: h.getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));

import { GET, POST } from "./route";
import { DELETE } from "./[tokenId]/route";

const ME = "44444444-4444-4444-8444-444444444444";
const ORG = "11111111-1111-4111-8111-111111111111";
const TOKEN_ID = "77777777-7777-4777-8777-777777777777";

const req = (method: string, body?: unknown, url = "http://localhost/api/v1/me/tokens") =>
  new NextRequest(url, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
const mint = (body: Record<string, unknown>) => POST(req("POST", { orgId: ORG, name: "ci", scopes: ["read"], ...body }));

beforeEach(() => {
  vi.clearAllMocks();
  h.authorization = null;
  h.getCurrentUser.mockResolvedValue({ id: ME });
  h.prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "acme", tenantClass: "COMMERCIAL" });
  h.getAuthContext.mockResolvedValue({ userId: ME, orgId: ORG });
  h.prisma.apiKey.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: TOKEN_ID, name: data.name, prefix: data.prefix, scopes: data.scopes, projectIds: data.projectIds,
    expiresAt: data.expiresAt, createdAt: new Date(), kind: data.kind,
  }));
});

describe("personal access tokens are managed from a browser session only", () => {
  it.each([
    ["list", () => GET(req("GET"))],
    ["mint", () => mint({})],
    ["revoke", () => DELETE(req("DELETE"), { params: Promise.resolve({ tokenId: TOKEN_ID }) })],
  ])("a token can't %s tokens, even alongside a valid cookie", async (_n, call) => {
    h.authorization = "Bearer cosmos_abc123_secret";
    const res = await call();
    expect(res.status).toBe(403);
    expect(h.prisma.apiKey.create).not.toHaveBeenCalled();
    expect(h.prisma.apiKey.delete).not.toHaveBeenCalled();
  });

  it("no session is a 401", async () => {
    h.getCurrentUser.mockResolvedValue(null);
    expect((await mint({})).status).toBe(401);
  });
});

describe("POST /me/tokens", () => {
  it("mints a PERSONAL key for the caller, expiring in 30 days by default, shown once", async () => {
    const res = await mint({});
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^cosmos_[0-9a-f]+_/);
    const data = h.prisma.apiKey.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ kind: "PERSONAL", createdById: ME, orgId: ORG, scopes: ["read"] });
    const days = (data.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "pat.created", entityId: TOKEN_ID }));
  });

  it("caps the lifetime at 90 days, 30 in a GOV org", async () => {
    expect((await mint({ expiresIn: 91 * 86_400 })).status).toBe(400);
    expect((await mint({ expiresIn: 90 * 86_400 })).status).toBe(201);
    h.prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "acme", tenantClass: "GOV" });
    expect((await mint({ expiresIn: 31 * 86_400 })).status).toBe(400);
    expect((await mint({ expiresIn: 3600 })).status).toBe(201);
  });

  it("an org you don't belong to (or whose floors you fail) reads as not found", async () => {
    h.getAuthContext.mockResolvedValue(null);
    expect((await mint({})).status).toBe(404);
    expect(h.prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it("refuses a project ceiling naming no project of this org", async () => {
    h.prisma.project.findMany.mockResolvedValue([]);
    expect((await mint({ projectIds: ["99999999-9999-4999-8999-999999999999"] })).status).toBe(400);
  });
});

describe("GET and DELETE /me/tokens", () => {
  it("lists only the caller's personal tokens", async () => {
    h.prisma.apiKey.findMany.mockResolvedValue([]);
    await GET(req("GET", undefined, `http://localhost/api/v1/me/tokens?orgId=${ORG}`));
    expect(h.prisma.apiKey.findMany.mock.calls[0][0].where).toEqual({ createdById: ME, kind: "PERSONAL", orgId: ORG });
  });

  it("revokes only your own personal token", async () => {
    h.prisma.apiKey.findFirst.mockResolvedValue(null);
    const res = await DELETE(req("DELETE"), { params: Promise.resolve({ tokenId: TOKEN_ID }) });
    expect(res.status).toBe(404);
    expect(h.prisma.apiKey.findFirst.mock.calls[0][0].where).toEqual({ id: TOKEN_ID, createdById: ME, kind: "PERSONAL" });
    h.prisma.apiKey.findFirst.mockResolvedValue({ id: TOKEN_ID, orgId: ORG, name: "ci" });
    expect((await DELETE(req("DELETE"), { params: Promise.resolve({ tokenId: TOKEN_ID }) })).status).toBe(204);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "pat.revoked" }));
  });
});
