import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, canReadInProject, isOrgAdministrator, canAdministerProject, projectsDenyingAction } = vi.hoisted(() => ({
  prisma: { document: { findFirst: vi.fn() }, documentShare: { findFirst: vi.fn() } },
  canReadInProject: vi.fn(),
  isOrgAdministrator: vi.fn(),
  canAdministerProject: vi.fn(),
  projectsDenyingAction: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rbac/project-access", () => ({ isOrgAdministrator }));
vi.mock("@/lib/rbac/require-project-read", () => ({ canReadInProject }));
vi.mock("@/lib/rbac/require-project-manage", () => ({ canAdministerProject }));
vi.mock("@/lib/work-items/query/scope", () => ({ projectsDenyingAction, getReadableProjectIds: vi.fn() }));

import { readableDocument, documentVisibilityWhere } from "../access";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const DOC = "55555555-5555-4555-8555-555555555555";

const bits = (...k: PermissionKey[]) => k.reduce((a, x) => a | Permission[x], 0n);
/** Every role that reaches the file routes reads projects, which is the bit for reading files. */
function ctx(role: OrgRole = OrgRole.MEMBER, ...k: PermissionKey[]): AuthContext {
  const permissions = bits(...(k.length ? k : (["ORG_READ", "PROJECT_READ"] as PermissionKey[])));
  return { userId: ME, orgId: ORG, orgRole: role, permissions, basePermissions: permissions, abacRules: [] } as AuthContext;
}
const restricted = {
  id: DOC, orgId: ORG, projectId: PROJECT, uploadedById: OWNER, visibility: "RESTRICTED" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  canReadInProject.mockResolvedValue(true);
  isOrgAdministrator.mockImplementation((r: OrgRole) => r === OrgRole.ADMIN || r === OrgRole.OWNER);
  projectsDenyingAction.mockResolvedValue(new Set());
  prisma.documentShare.findFirst.mockResolvedValue(null);
});

describe("readableDocument — RESTRICTED", () => {
  it("hides a restricted file from a project member who was not named", async () => {
    prisma.document.findFirst.mockResolvedValue(restricted);
    // The whole point: the project IS visible, and the file still is not.
    canReadInProject.mockResolvedValue(true);
    expect(await readableDocument(ORG, DOC, ctx())).toBeNull();
  });

  it("shows it to whoever uploaded it, without consulting anything else", async () => {
    prisma.document.findFirst.mockResolvedValue({ ...restricted, uploadedById: ME });
    expect(await readableDocument(ORG, DOC, ctx())).not.toBeNull();
    expect(prisma.documentShare.findFirst).not.toHaveBeenCalled();
    // A grant passes over team scoping, so the project's own check is not asked.
    expect(canReadInProject).not.toHaveBeenCalled();
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
    canReadInProject.mockResolvedValue(false);
    prisma.documentShare.findFirst.mockResolvedValue({ id: "s1" });
    expect(await readableDocument(ORG, DOC, ctx())).not.toBeNull();
  });

  it("shows it to an org administrator — stated, not implied", async () => {
    prisma.document.findFirst.mockResolvedValue(restricted);
    expect(await readableDocument(ORG, DOC, ctx(OrgRole.ADMIN))).not.toBeNull();
    expect(prisma.documentShare.findFirst).not.toHaveBeenCalled();
  });

  it("a deny rule on the file's project closes every grant", async () => {
    prisma.document.findFirst.mockResolvedValue({ ...restricted, uploadedById: ME });
    projectsDenyingAction.mockResolvedValue(new Set([PROJECT]));
    expect(await readableDocument(ORG, DOC, ctx())).toBeNull();
    expect(projectsDenyingAction).toHaveBeenCalledWith(expect.anything(), "PROJECT_READ", [PROJECT]);
  });

  // An API key's permissions are its minter's narrowed to its scopes. A key whose
  // scopes leave out files must not open one on its minter's role, upload or share.
  it("without the bit for reading files, no grant opens it: role, upload or share", async () => {
    const noFiles = (role: OrgRole) => ctx(role, "ORG_READ", "ITEM_READ");
    prisma.document.findFirst.mockResolvedValue(restricted);
    expect(await readableDocument(ORG, DOC, noFiles(OrgRole.ADMIN))).toBeNull();
    prisma.document.findFirst.mockResolvedValue({ ...restricted, uploadedById: ME });
    expect(await readableDocument(ORG, DOC, noFiles(OrgRole.MEMBER))).toBeNull();
    prisma.document.findFirst.mockResolvedValue(restricted);
    prisma.documentShare.findFirst.mockResolvedValue({ id: "s1" });
    expect(await readableDocument(ORG, DOC, noFiles(OrgRole.MEMBER))).toBeNull();
    // Control: the same administrator with the bit is let in.
    expect(await readableDocument(ORG, DOC, ctx(OrgRole.ADMIN))).not.toBeNull();
  });
});

describe("readableDocument — INHERIT is unchanged", () => {
  it("still follows the project", async () => {
    prisma.document.findFirst.mockResolvedValue({ ...restricted, visibility: "INHERIT" });
    canReadInProject.mockResolvedValue(false);
    expect(await readableDocument(ORG, DOC, ctx())).toBeNull();
    // The same question the project's document routes ask, with the same action.
    expect(canReadInProject).toHaveBeenCalledWith(expect.anything(), PROJECT, "PROJECT_READ");
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

  it("without the bit for reading files, lists no restricted file at all, even for an administrator", () => {
    const w = documentVisibilityWhere(ctx(OrgRole.ADMIN, "ORG_READ", "ITEM_READ"), new Set([PROJECT]));
    expect(w).toEqual({ visibility: "INHERIT", OR: [{ projectId: null }, { projectId: { in: [PROJECT] } }] });
  });

  it("a deny set closes the restricted arms, keeping org-wide files", () => {
    const bound = { OR: [{ projectId: null }, { projectId: { notIn: [PROJECT] } }] };
    for (const role of [OrgRole.MEMBER, OrgRole.ADMIN]) {
      const w = documentVisibilityWhere(ctx(role), new Set(), new Set([PROJECT]));
      const rest = (w.OR as Array<Record<string, unknown>>).find((c) => c.visibility === "RESTRICTED");
      expect(rest?.AND, role).toEqual([bound]);
    }
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

// A project-scoped API key sees no restricted file filed in another project,
// not even one its minter uploaded or was named on: readableDocument applies the
// key's ceiling before any grant. The list fragment did not, so a scoped key's
// list named restricted files from projects the key cannot reach.
describe("documentVisibilityWhere — a project-scoped key's ceiling binds restricted files too", () => {
  const OTHER = "66666666-6666-4666-8666-666666666666";
  const ceiling = { OR: [{ projectId: null }, { projectId: { in: [PROJECT] } }] };
  const scoped = (role?: OrgRole) => ({ ...ctx(role), isApiKey: true, projectScope: [PROJECT] }) as AuthContext;
  const restrictedClause = (w: ReturnType<typeof documentVisibilityWhere>) =>
    (w.OR as Array<Record<string, unknown>>).find((c) => c.visibility === "RESTRICTED");

  it("a member's key: the grant still applies, inside the key's projects", () => {
    const w = documentVisibilityWhere(scoped(), new Set([PROJECT]));
    expect(restrictedClause(w)).toEqual({
      visibility: "RESTRICTED",
      AND: [ceiling],
      OR: [{ uploadedById: ME }, { shares: { some: { userId: ME } } }],
    });
  });

  it("an administrator's key: every restricted file, but only inside the key's projects", () => {
    const w = documentVisibilityWhere(scoped(OrgRole.ADMIN), new Set([PROJECT]));
    expect(restrictedClause(w)).toEqual({ visibility: "RESTRICTED", AND: [ceiling] });
  });

  it("the ceiling names only the key's projects, never the caller's wider set", () => {
    const w = documentVisibilityWhere(scoped(), new Set([PROJECT, OTHER]));
    expect(JSON.stringify(restrictedClause(w))).not.toContain(OTHER);
  });
});
