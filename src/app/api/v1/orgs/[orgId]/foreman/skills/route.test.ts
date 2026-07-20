// @vitest-environment node
//
// Foreman skills manager list+create route. Proves:
//   - GET lists both project-wide (orgId:null) and this org's skills;
//   - POST mode:"create" requires name+description, slugifies the name,
//     stamps source:"authored" and createdById;
//   - POST mode:"import" parses a pasted SKILL.md via parseSkillMarkdown and
//     stamps source:"imported";
//   - a duplicate name in the same scope is 409 (no create call);
//   - a caller without ORG_MANAGE_SETTINGS is 403 (no read/write);
//   - 401 with no auth context, 404 when the org doesn't exist.
//
// Mocks only the I/O boundaries (session, db) — mirrors the mocking idiom
// from foreman/harness/route.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { getAuthContext, requireSystemAdmin, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  requireSystemAdmin: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    foremanSkill: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/internal/require-system-admin", () => ({ requireSystemAdmin }));
vi.mock("@/lib/db/client", () => ({ prisma }));

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
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/foreman/skills`, {
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
  prisma.foremanSkill.findFirst.mockResolvedValue(null);
});

describe("GET /orgs/[orgId]/foreman/skills", () => {
  it("lists project-wide (orgId:null) and this org's skills", async () => {
    const rows = [
      { id: "s1", orgId: null, name: "cosmos-architecture", description: "d1", enabled: true, source: "authored" },
      { id: "s2", orgId: ORG_ID, name: "custom-skill", description: "d2", enabled: true, source: "authored" },
    ];
    prisma.foremanSkill.findMany.mockResolvedValue(rows);

    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skills: rows });
    expect(prisma.foremanSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ orgId: null }, { orgId: ORG_ID }] },
      }),
    );
  });
});

describe("POST /orgs/[orgId]/foreman/skills — mode:create", () => {
  it("creates an org-scoped skill, slugifying the name and stamping source:authored + createdById", async () => {
    prisma.foremanSkill.create.mockResolvedValue({ id: "new-1" });

    const res = await POST(
      req("POST", {
        mode: "create",
        name: "My Custom Skill!",
        description: "A description.",
        body: "# My Custom Skill\n\nBody text.",
        orgScope: true,
      }),
      { params },
    );

    expect(res.status).toBe(201);
    expect(prisma.foremanSkill.create).toHaveBeenCalledTimes(1);
    const arg = prisma.foremanSkill.create.mock.calls[0][0] as {
      data: {
        orgId: string | null;
        name: string;
        description: string;
        source: string;
        createdById: string;
      };
    };
    expect(arg.data.orgId).toBe(ORG_ID);
    expect(arg.data.name).toBe("my-custom-skill");
    expect(arg.data.source).toBe("authored");
    expect(arg.data.createdById).toBe(ACTOR_ID);
  });

  it("project-scope (orgScope:false) creates with orgId:null", async () => {
    prisma.foremanSkill.create.mockResolvedValue({ id: "new-2" });

    await POST(
      req("POST", {
        mode: "create",
        name: "proj-skill",
        description: "d",
        body: "body",
        orgScope: false,
      }),
      { params },
    );

    const arg = prisma.foremanSkill.create.mock.calls[0][0] as { data: { orgId: string | null } };
    expect(arg.data.orgId).toBeNull();
  });

  it("403 for a non-platform-admin creating a PROJECT-wide skill (no write happens)", async () => {
    requireSystemAdmin.mockResolvedValue(null);
    const res = await POST(
      req("POST", { mode: "create", name: "proj-skill", description: "d", body: "body", orgScope: false }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(prisma.foremanSkill.create).not.toHaveBeenCalled();
  });

  it("400 when name or description is missing for mode:create", async () => {
    const res = await POST(
      req("POST", { mode: "create", body: "b", orgScope: true }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(prisma.foremanSkill.create).not.toHaveBeenCalled();
  });
});

describe("POST /orgs/[orgId]/foreman/skills — mode:import", () => {
  it("parses the pasted SKILL.md and stamps source:imported", async () => {
    prisma.foremanSkill.create.mockResolvedValue({ id: "new-3" });
    const md = `---
name: cosmos-conventions
description: House style for cosmos-v2.
---

# cosmos-v2 conventions

Body.
`;

    const res = await POST(
      req("POST", { mode: "import", body: md, orgScope: false }),
      { params },
    );

    expect(res.status).toBe(201);
    const arg = prisma.foremanSkill.create.mock.calls[0][0] as {
      data: { name: string; description: string; body: string; source: string };
    };
    expect(arg.data.name).toBe("cosmos-conventions");
    expect(arg.data.description).toBe("House style for cosmos-v2.");
    expect(arg.data.body).toBe(md);
    expect(arg.data.source).toBe("imported");
  });
});

describe("POST /orgs/[orgId]/foreman/skills — duplicates", () => {
  it("409 when a skill with the same name already exists in that scope", async () => {
    prisma.foremanSkill.findFirst.mockResolvedValue({ id: "existing", name: "dup-skill" });

    const res = await POST(
      req("POST", {
        mode: "create",
        name: "dup-skill",
        description: "d",
        body: "b",
        orgScope: true,
      }),
      { params },
    );

    expect(res.status).toBe(409);
    expect(prisma.foremanSkill.create).not.toHaveBeenCalled();
  });
});

describe("foreman/skills — auth", () => {
  it("403 for a caller lacking ORG_MANAGE_SETTINGS (GET)", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("ORG_READ") }));
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(403);
    expect(prisma.foremanSkill.findMany).not.toHaveBeenCalled();
  });

  it("403 for a caller lacking ORG_MANAGE_SETTINGS (POST) — no write happens", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("ORG_READ") }));
    const res = await POST(
      req("POST", { mode: "create", name: "n", description: "d", body: "b", orgScope: true }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(prisma.foremanSkill.create).not.toHaveBeenCalled();
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
