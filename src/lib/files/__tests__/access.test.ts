import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, isProjectVisible, canAdministerProject } = vi.hoisted(() => ({
  prisma: { document: { findFirst: vi.fn() } },
  isProjectVisible: vi.fn(),
  canAdministerProject: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rbac/project-access", () => ({ isProjectVisible }));
vi.mock("@/lib/rbac/require-project-manage", () => ({ canAdministerProject }));

import { readableDocument, canManageDocument } from "../access";

const ORG = "11111111-1111-1111-1111-111111111111";
const ME = "22222222-2222-2222-2222-222222222222";
const SOMEONE = "33333333-3333-3333-3333-333333333333";
const PROJECT = "44444444-4444-4444-4444-444444444444";
const DOC = "55555555-5555-5555-5555-555555555555";

const bits = (...k: PermissionKey[]) => k.reduce((a, x) => a | Permission[x], 0n);
function ctx(...k: PermissionKey[]): AuthContext {
  const permissions = bits(...k);
  return {
    userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER,
    permissions, basePermissions: permissions, abacRules: [],
  } as AuthContext;
}
const projectDoc = { id: DOC, orgId: ORG, projectId: PROJECT, uploadedById: SOMEONE };
const orgDoc = { id: DOC, orgId: ORG, projectId: null, uploadedById: SOMEONE };

beforeEach(() => {
  vi.clearAllMocks();
  isProjectVisible.mockResolvedValue(true);
  canAdministerProject.mockResolvedValue(false);
});

describe("readableDocument", () => {
  it("is null for a document that is not there, without saying which kind of absent", async () => {
    prisma.document.findFirst.mockResolvedValue(null);
    expect(await readableDocument(ORG, DOC, ctx("ORG_READ"))).toBeNull();
  });

  it("scopes the lookup by org, so another tenant's id is simply absent", async () => {
    prisma.document.findFirst.mockResolvedValue(null);
    await readableDocument(ORG, DOC, ctx("ORG_READ"));
    expect(prisma.document.findFirst.mock.calls[0][0].where).toEqual({ id: DOC, orgId: ORG });
  });

  it("lets any org reader see a document filed against no project", async () => {
    prisma.document.findFirst.mockResolvedValue(orgDoc);
    expect(await readableDocument(ORG, DOC, ctx("ORG_READ"))).toEqual(orgDoc);
    // No project to consult, so it must not ask.
    expect(isProjectVisible).not.toHaveBeenCalled();
  });

  it("makes a project document exactly as visible as its project", async () => {
    prisma.document.findFirst.mockResolvedValue(projectDoc);
    isProjectVisible.mockResolvedValue(false);
    // The assertion that matters: fetching by id must not be a way round the
    // narrowing the library list applies in its query.
    expect(await readableDocument(ORG, DOC, ctx("ORG_READ"))).toBeNull();
    expect(isProjectVisible).toHaveBeenCalledWith(expect.anything(), PROJECT);
  });

  it("returns it when the project is visible", async () => {
    prisma.document.findFirst.mockResolvedValue(projectDoc);
    expect(await readableDocument(ORG, DOC, ctx("ORG_READ"))).toEqual(projectDoc);
  });
});

describe("canManageDocument", () => {
  it("lets the uploader manage their own file with no other right at all", async () => {
    const mine = { ...projectDoc, uploadedById: ME };
    expect(await canManageDocument(mine, ctx())).toBe(true);
    // The point of the rule: no project manager has to be found first.
    expect(canAdministerProject).not.toHaveBeenCalled();
  });

  it("refuses somebody else's project file when they do not manage the project", async () => {
    canAdministerProject.mockResolvedValue(false);
    expect(await canManageDocument(projectDoc, ctx("ORG_READ"))).toBe(false);
  });

  it("allows a project manager on somebody else's project file", async () => {
    canAdministerProject.mockResolvedValue(true);
    expect(await canManageDocument(projectDoc, ctx("ORG_READ"))).toBe(true);
  });

  it("falls to ORG_UPDATE for a file filed against no project", async () => {
    expect(await canManageDocument(orgDoc, ctx("ORG_READ"))).toBe(false);
    expect(await canManageDocument(orgDoc, ctx("ORG_READ", "ORG_UPDATE"))).toBe(true);
    // An org-wide file has no project, so the project right must never be asked
    // about — doing so would throw on a null projectId.
    expect(canAdministerProject).not.toHaveBeenCalled();
  });

  it("does not let PROJECT_UPDATE on paper stand in for managing THIS project", async () => {
    // canAdministerProject already folds the org-wide bit in; this asserts the
    // policy delegates rather than second-guessing it with its own bit check.
    canAdministerProject.mockResolvedValue(false);
    expect(await canManageDocument(projectDoc, ctx("ORG_READ", "PROJECT_UPDATE"))).toBe(false);
  });
});
