import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthContext } from "@/lib/rbac/check";

/**
 * A project-scoped key must not reach outside its projects — and the case that
 * actually matters is an OWNER's key.
 *
 * `getReadableProjectIds` short-circuits to EVERY project for an OWNER, and
 * `isProjectVisible` returns true for any org administrator. Both are correct
 * for a person: a project must not be lockable away from whoever runs the org.
 * But a key is not a person. It is a credential handed to a script, and the
 * whole reason to scope one is that its holder should reach less than its
 * minter could. A ceiling evaluated AFTER those short-circuits would therefore
 * bind for everyone except the people most likely to mint a key.
 *
 * So these tests are specifically about an OWNER context. If they pass for an
 * OWNER they pass for everyone below.
 */

const projects = [
  { id: "p1", teamScopedAccess: false },
  { id: "p2", teamScopedAccess: false },
  { id: "p3", teamScopedAccess: false },
];

vi.mock("@/lib/db/client", () => ({
  prisma: {
    project: {
      findMany: vi.fn(async () => projects),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        projects.find((p) => p.id === where.id) ?? null,
      ),
    },
    orgMember: { findUnique: vi.fn(async () => null) },
    projectMember: { findMany: vi.fn(async () => []) },
  },
}));

import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { isProjectVisible } from "@/lib/rbac/project-access";
import { canManageProject, getManagedProjectIds } from "@/lib/rbac/scope";
import { canManageBoardsInProject, canWriteInProject } from "@/lib/rbac/project-role";
import { canAdministerProject } from "@/lib/rbac/require-project-manage";
import { requireAccess } from "@/lib/abac/require-access";
import { inKeyProjectScope } from "@/lib/rbac/check";

const owner = (projectScope?: string[]): AuthContext =>
  ({
    userId: "u1",
    orgId: "o1",
    orgRole: "OWNER",
    permissions: ~0n,
    basePermissions: ~0n,
    abacRules: [],
    projectScope,
  }) as AuthContext;

beforeEach(() => vi.clearAllMocks());

describe("an unscoped key or session is unchanged", () => {
  it("an OWNER with no ceiling still reads every project", () => {
    // The negative control for everything below: if this ever returns a subset,
    // the tests that follow would pass for the wrong reason.
    return expect(getReadableProjectIds(owner())).resolves.toEqual(["p1", "p2", "p3"]);
  });

  it("and every project stays visible", async () => {
    for (const id of ["p1", "p2", "p3"]) {
      expect(await isProjectVisible(owner(), id), id).toBe(true);
    }
  });
});

describe("a project-scoped key narrows an OWNER", () => {
  it("reads only the projects in its ceiling", async () => {
    await expect(getReadableProjectIds(owner(["p2"]))).resolves.toEqual(["p2"]);
  });

  it("cannot see a project outside the ceiling", async () => {
    expect(await isProjectVisible(owner(["p2"]), "p1")).toBe(false);
    expect(await isProjectVisible(owner(["p2"]), "p3")).toBe(false);
  });

  it("can see the one inside it", async () => {
    expect(await isProjectVisible(owner(["p2"]), "p2")).toBe(true);
  });

  it("ignores a project id that is not in the org", async () => {
    // Naming a stranger's project cannot conjure access to it.
    await expect(getReadableProjectIds(owner(["p2", "p-elsewhere"]))).resolves.toEqual(["p2"]);
    expect(await isProjectVisible(owner(["p2", "p-elsewhere"]), "p-elsewhere")).toBe(false);
  });

  it("reads nothing when the ceiling names only unknown projects", async () => {
    await expect(getReadableProjectIds(owner(["p-elsewhere"]))).resolves.toEqual([]);
  });
});

describe("empty vs absent — the distinction that protects existing keys", () => {
  it("an ABSENT ceiling means org-wide", async () => {
    // Every key minted before project scoping existed stores `[]`, and
    // verifyApiKey maps `[]` to undefined precisely so those keep working.
    await expect(getReadableProjectIds(owner(undefined))).resolves.toEqual(["p1", "p2", "p3"]);
  });

  it("an EMPTY ceiling would deny everything — which is why [] never reaches here", async () => {
    // Documents the hazard rather than endorsing it: if `[]` were ever passed
    // through as a ceiling, every pre-existing key would reach nothing at all.
    await expect(getReadableProjectIds(owner([]))).resolves.toEqual([]);
  });
});

describe("the write-side gates hold the same ceiling", () => {
  // An OWNER's key: every one of these says yes to the person, so a "no" here
  // is the ceiling and nothing else.
  it("manages, administers, writes and makes boards only inside the ceiling", async () => {
    for (const [name, gate] of [
      ["canManageProject", (c: AuthContext, p: string) => canManageProject(c, p)],
      ["canAdministerProject", (c: AuthContext, p: string) => canAdministerProject(c, p)],
      ["canWriteInProject", (c: AuthContext, p: string) => canWriteInProject(c, p)],
      ["canManageBoardsInProject", (c: AuthContext, p: string) => canManageBoardsInProject(c, p)],
    ] as const) {
      expect(await gate(owner(["p2"]), "p2"), `${name} inside`).toBe(true);
      expect(await gate(owner(["p2"]), "p1"), `${name} outside`).toBe(false);
      expect(await gate(owner(), "p1"), `${name} unscoped`).toBe(true);
    }
  });

  it("lists as managed only the projects inside the ceiling", async () => {
    expect([...(await getManagedProjectIds(owner(["p2"]), ["p1", "p2", "p3"]))]).toEqual(["p2"]);
    expect([...(await getManagedProjectIds(owner(), ["p1", "p2"]))]).toEqual(["p1", "p2"]);
  });
});

describe("an unresolved project fails closed for a scoped key", () => {
  it("inKeyProjectScope: no project id is outside any ceiling, and inside none", () => {
    expect(inKeyProjectScope(owner(["p2"]), null)).toBe(false);
    expect(inKeyProjectScope(owner(["p2"]), "")).toBe(false);
    expect(inKeyProjectScope(owner(), null)).toBe(true);
  });

  it("an EMPTY ceiling writes nowhere either (fails closed, never org-wide)", async () => {
    // verifyApiKey maps a stored [] to undefined, so [] shouldn't reach a gate;
    // if it ever does, it must mean "no project", not "every project".
    expect(inKeyProjectScope(owner([]), "p1")).toBe(false);
    await expect(requireAccess(owner([]), "ITEM_DELETE", { projectId: "p1" })).rejects.toThrow("Access denied by policy");
    expect(await canAdministerProject(owner([]), "p1")).toBe(false);
  });

  it("requireAccess refuses a resource whose project couldn't be resolved, for a scoped key only", async () => {
    await expect(requireAccess(owner(["p2"]), "ITEM_UPDATE", { projectId: null })).rejects.toThrow("Access denied by policy");
    await expect(requireAccess(owner(["p2"]), "ITEM_UPDATE", { projectId: undefined })).rejects.toThrow("Access denied by policy");
    await expect(requireAccess(owner(), "ITEM_UPDATE", { projectId: null })).resolves.toBeUndefined();
    // An action that names no project at all (an org-level one) is not a project route.
    await expect(requireAccess(owner(["p2"]), "ITEM_UPDATE", { createdById: "u1" })).resolves.toBeUndefined();
  });
});
