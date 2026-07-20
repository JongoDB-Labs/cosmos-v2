// @vitest-environment node
//
// Foreman MCP servers manager list+create route. Proves:
//   - GET lists both project-wide (orgId:null) and this org's servers, and
//     NEVER selects/returns `headers`;
//   - POST slugifies the name, seals headers via sealMcpJson, stamps
//     createdById;
//   - a non-http(s) url is 422 (defense in depth beyond z.string().url());
//   - a duplicate name in the same scope is 409 (no create call);
//   - project-scope (orgScope:false) by a non-platform-admin is 403 (no
//     write happens) — the CRITICAL security-model case for this route;
//   - a caller without ORG_MANAGE_SETTINGS is 403 (no read/write);
//   - 401 with no auth context, 404 when the org doesn't exist.
//
// Mocks only the I/O boundaries (session, db, seal) — mirrors the mocking
// idiom from foreman/skills/route.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { getAuthContext, requireSystemAdmin, prisma, sealMcpJson } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  requireSystemAdmin: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    foremanMcpServer: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
  sealMcpJson: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/internal/require-system-admin", () => ({ requireSystemAdmin }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/integrations/mcp-secrets", () => ({ sealMcpJson }));

import { GET, POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const params = Promise.resolve({ orgId: ORG_ID });

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(opts: { permissions?: bigint; orgRole?: OrgRole }): AuthContext {
  const perms = opts.permissions ?? bits("ORG_READ", "ORG_MANAGE_SETTINGS");
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: opts.orgRole ?? OrgRole.ADMIN,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}

function req(method: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/foreman/mcp-servers`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctxWith({}));
  requireSystemAdmin.mockResolvedValue({ id: "sysadmin" });
  prisma.foremanMcpServer.findFirst.mockResolvedValue(null);
  sealMcpJson.mockReturnValue(null);
});

describe("GET /orgs/[orgId]/foreman/mcp-servers", () => {
  it("lists project-wide (orgId:null) and this org's servers, without headers", async () => {
    const rows = [
      { id: "m1", orgId: null, name: "shared-docs", url: "https://mcp.example.com", enabled: true },
      { id: "m2", orgId: ORG_ID, name: "acme-tool", url: "https://acme.example.com/mcp", enabled: true },
    ];
    prisma.foremanMcpServer.findMany.mockResolvedValue(rows);

    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servers: rows });
    expect(prisma.foremanMcpServer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ orgId: null }, { orgId: ORG_ID }] },
        select: expect.not.objectContaining({ headers: true }),
      }),
    );
  });
});

describe("POST /orgs/[orgId]/foreman/mcp-servers", () => {
  it("creates an org-scoped server, slugifying the name, sealing headers, stamping createdById", async () => {
    sealMcpJson.mockReturnValue("sealed:v1:ciphertext");
    prisma.foremanMcpServer.create.mockResolvedValue({ id: "new-1" });

    const res = await POST(
      req("POST", {
        name: "My MCP Server!",
        url: "https://mcp.example.com/rpc",
        headers: { Authorization: "Bearer abc123" },
        orgScope: true,
      }),
      { params },
    );

    expect(res.status).toBe(201);
    expect(sealMcpJson).toHaveBeenCalledWith({ Authorization: "Bearer abc123" });
    expect(prisma.foremanMcpServer.create).toHaveBeenCalledTimes(1);
    const arg = prisma.foremanMcpServer.create.mock.calls[0][0] as {
      data: {
        orgId: string | null;
        name: string;
        url: string;
        headers: string | null;
        createdById: string;
      };
    };
    expect(arg.data.orgId).toBe(ORG_ID);
    expect(arg.data.name).toBe("my-mcp-server");
    expect(arg.data.headers).toBe("sealed:v1:ciphertext");
    expect(arg.data.createdById).toBe(ACTOR_ID);
  });

  it("project-scope (orgScope:false) creates with orgId:null", async () => {
    prisma.foremanMcpServer.create.mockResolvedValue({ id: "new-2" });

    await POST(
      req("POST", { name: "proj-server", url: "https://mcp.example.com", orgScope: false }),
      { params },
    );

    const arg = prisma.foremanMcpServer.create.mock.calls[0][0] as { data: { orgId: string | null } };
    expect(arg.data.orgId).toBeNull();
  });

  it("403 for a non-platform-admin creating a PROJECT-wide server (no write happens)", async () => {
    requireSystemAdmin.mockResolvedValue(null);
    const res = await POST(
      req("POST", { name: "proj-server", url: "https://mcp.example.com", orgScope: false }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(prisma.foremanMcpServer.create).not.toHaveBeenCalled();
  });

  it("422 for a file:// url — passes z.string().url() but is not http(s) (no local commands)", async () => {
    const res = await POST(
      req("POST", { name: "evil", url: "file:///etc/passwd", orgScope: true }),
      { params },
    );
    expect(res.status).toBe(422);
    expect(prisma.foremanMcpServer.create).not.toHaveBeenCalled();
  });

  it("422 for an ftp(s) url — passes z.string().url() but is not http(s)", async () => {
    const res = await POST(
      req("POST", { name: "evil-ftp", url: "ftp://mcp.example.com", orgScope: true }),
      { params },
    );
    expect(res.status).toBe(422);
    expect(prisma.foremanMcpServer.create).not.toHaveBeenCalled();
  });

  it("409 when a server with the same name already exists in that scope", async () => {
    prisma.foremanMcpServer.findFirst.mockResolvedValue({ id: "existing", name: "dup-server" });

    const res = await POST(
      req("POST", { name: "dup-server", url: "https://mcp.example.com", orgScope: true }),
      { params },
    );

    expect(res.status).toBe(409);
    expect(prisma.foremanMcpServer.create).not.toHaveBeenCalled();
  });
});

describe("foreman/mcp-servers — auth", () => {
  it("403 for a caller lacking ORG_MANAGE_SETTINGS (GET)", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("ORG_READ") }));
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(403);
    expect(prisma.foremanMcpServer.findMany).not.toHaveBeenCalled();
  });

  it("403 for a caller lacking ORG_MANAGE_SETTINGS (POST) — no write happens", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("ORG_READ") }));
    const res = await POST(
      req("POST", { name: "n", url: "https://mcp.example.com", orgScope: true }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(prisma.foremanMcpServer.create).not.toHaveBeenCalled();
  });

  it("401 when there is no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(401);
  });

  it("404 when the org does not exist", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(404);
  });
});
