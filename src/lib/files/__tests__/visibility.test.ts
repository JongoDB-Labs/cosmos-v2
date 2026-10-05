import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, isProjectVisible, isOrgAdministrator, canAdministerProject } = vi.hoisted(() => ({
  prisma: { document: { findFirst: vi.fn() }, documentShare: { findFirst: vi.fn() } },
  isProjectVisible: vi.fn(),
  isOrgAdministrator: vi.fn(),
  canAdministerProject: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rbac/project-access", () => ({ isProjectVisible, isOrgAdministrator }));
vi.mock("@/lib/rbac/require-project-manage", () => ({ canAdministerProject }));

import { readableDocument, documentVisibilityWhere } from "../access";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const DOC = "55555555-5555-4555-8555-555555555555";

const bits = (...k: PermissionKey[]) => k.reduce((a, x) => a | Permission[x], 0n);
function ctx(role: OrgRole = OrgRole.MEMBER): AuthContext {
  const permissions = bits("ORG_READ");
  return { userId: ME, orgId: ORG, orgRole: role, permissions, basePermissions: permissions, abacRules: [] } as AuthContext;
}
const restricted = {
  id: DOC, orgId: ORG, projectId: PROJECT, uploadedById: OWNER, visibility: "RESTRICTED" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  isProjectVisible.mockResolvedValue(true);
  isOrgAdministrator.mockReturnValue(false);
  prisma.documentShare.findFirst.mockResolvedValue(null);
});

describe("readableDocument — RESTRICTED", () => {
  it("hides a restricted file from a project member who was not named", async () => {
    prisma.document.findFirst.mockResolvedValue(restricted);
    // The whole point: the project IS visible, and the file still is not.
    isProjectVisible.mockResolvedValue(true);
    expect(await readableDocument(ORG, DOC, ctx())).toBeNull();
  });

  it("shows it to whoever uploaded it, without consulting anything else", async () => {
    prisma.document.findFirst.mockResolvedValue({ ...restricted, uploadedById: ME });
    expect(await readableDocument(ORG, DOC, ctx())).not.toBeNull();
    expect(prisma.documentShare.findFirst).not.toHaveBeenCalled();
    expect(isProjectVisible).not.toHaveBeenCalled();
  });

  it("shows it to somebody it was shared with", async () => {
    prisma.document.findFirst.mockResolvedValue(restricted);
    prisma.documentShare.findFirst.mockResolvedValue({ id: "s1" });
    expect(await readableDocument(ORG, DOC, ctx())).not.toBeNull();
    expect(prisma.documentShare.findFirst.mock.calls[0][0].where).toEqual({
      documentId: DOC, userId: ME,
    });
  });

  it("shares OUTWARD: a named person sees it even where the project would not let them", async () => {
    // Sharing is the other half of limiting. An explicit grant by the owner beats
    // project membership, and it is recorded with who granted it.
    prisma.document.findFirst.mockResolvedValue(restricted);
    isProjectVisible.mockResolvedValue(false);
    prisma.documentShare.findFirst.mockResolvedValue({ id: "s1" });
    expect(await readableDocument(ORG, DOC, ctx())).not.toBeNull();
  });

  it("shows it to an org administrator — stated, not implied", async () => {
    prisma.document.findFirst.mockResolvedValue(restricted);
    isOrgAdministrator.mockReturnValue(true);
    expect(await readableDocument(ORG, DOC, ctx(OrgRole.ADMIN))).not.toBeNull();
    expect(prisma.documentShare.findFirst).not.toHaveBeenCalled();
  });
});

describe("readableDocument — INHERIT is unchanged", () => {
  it("still follows the project", async () => {
    prisma.document.findFirst.mockResolvedValue({ ...restricted, visibility: "INHERIT" });
    isProjectVisible.mockResolvedValue(false);
    expect(await readableDocument(ORG, DOC, ctx())).toBeNull();
    // No grant lookup for an unrestricted file: that table is only consulted when
    // restriction is actually on.
    expect(prisma.documentShare.findFirst).not.toHaveBeenCalled();
  });
});

describe("documentVisibilityWhere — the LIST must agree with the by-id rule", () => {
  it("lets an ordinary member see inherited files plus their own and shared restricted ones", () => {
    const w = documentVisibilityWhere(ctx(), new Set([PROJECT]));
    expect(w.OR).toHaveLength(2);
    // The union is narrower for a member than for an admin, so the clause shape
    // differs between branches; read it structurally rather than by its type.
    const clauses = w.OR as Array<Record<string, unknown>>;
    const rest = clauses.find((c) => c.visibility === "RESTRICTED");
    // A restricted file reaches the list ONLY through one of these two.
    expect(rest?.OR).toEqual([
      { uploadedById: ME },
      { shares: { some: { userId: ME } } },
    ]);
  });

  it("gives an administrator every restricted file, with no grant clause", () => {
    isOrgAdministrator.mockReturnValue(true);
    const w = documentVisibilityWhere(ctx(OrgRole.ADMIN), new Set([PROJECT]));
    const rest = (w.OR as Array<Record<string, unknown>>).find(
      (c) => c.visibility === "RESTRICTED",
    );
    expect(rest).toEqual({ visibility: "RESTRICTED" });
  });

  it("narrows INHERIT to org-wide files only when asked for that scope", () => {
    const w = documentVisibilityWhere(ctx(), null);
    const inh = (w.OR as Array<Record<string, unknown>>).find((c) => c.visibility === "INHERIT");
    expect(inh).toEqual({ visibility: "INHERIT", projectId: null });
  });

  it("never emits a clause that would match a restricted file unconditionally", () => {
    // The failure that matters is a bare { visibility: "RESTRICTED" } for somebody
    // who is not an administrator — that is the whole library, disclosed.
    const w = documentVisibilityWhere(ctx(), new Set([PROJECT]));
    for (const clause of w.OR as Array<Record<string, unknown>>) {
      if (clause.visibility === "RESTRICTED") {
        expect(Object.keys(clause).sort()).toEqual(["OR", "visibility"]);
      }
    }
  });
});
