import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { apiKeyAuthContext, mintApiKey } from "@/lib/auth/api-key";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { executeTool } from "../tool-executor";
import { API_VERSION } from "@/lib/openapi/version";

/**
 * The assistant's tools must act with the CALLER's authority, not the authority
 * of the user behind it.
 *
 * `getAuthContext` accepts API keys, so the assistant routes can be driven by a
 * key. A key's AuthContext is the minting user's permissions INTERSECTED with
 * the key's scopes, an optional project ceiling, and no OWNER break-glass. The
 * executors used to throw that away and rebuild permissions from the user id
 * (`loadEffectivePermissions(orgId, userId)`), so a read-only key could have
 * the assistant delete work items as the full user, and a key limited to one
 * project could read and write every other project.
 *
 * DB-backed: the keys are minted for real and resolved by `apiKeyAuthContext`,
 * the function `verifyApiKeyHeader` returns from, so the AuthContext under test
 * is exactly what `getAuthContext` hands a route for that key.
 */
describe("AI tools honor the caller's API-key scope (e2e DB)", () => {
  const orgIds: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  });

  async function setup() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `keyscope ${stamp}`, slug: `keyscope-${stamp}` },
    });
    orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const suffix = stamp.slice(-4).toUpperCase();
    const projectA = await prisma.project.create({
      data: { orgId: org.id, name: "Alpha", key: `KA${suffix}` },
    });
    const projectB = await prisma.project.create({
      data: { orgId: org.id, name: "Bravo", key: `KB${suffix}` },
    });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    const mk = (projectId: string, title: string) =>
      prisma.workItem.create({
        data: {
          orgId: org.id, projectId, ticketNumber: Math.floor(Math.random() * 1_000_000), title,
          description: "", columnKey: "todo", workItemTypeId: type.id, createdById: owner.id,
        },
      });
    const itemA = await mk(projectA.id, `alpha-item-${stamp}`);
    const itemB = await mk(projectB.id, `bravo-item-${stamp}`);

    /**
     * Mint a real key and resolve the context it acts with, through the same
     * `apiKeyAuthContext` that `verifyApiKeyHeader` (and so `getAuthContext`)
     * returns for it once the secret matches. Secret verification itself is
     * covered by src/lib/auth/__tests__/api-key.test.ts; what matters here is
     * the scoped context that reaches the tools.
     */
    async function keyAuth(scopes: string[], projectIds?: string[]): Promise<AuthContext> {
      const { record } = await mintApiKey({
        orgId: org.id, name: `k-${scopes.join("+")}`, scopes, createdById: owner.id, projectIds,
      });
      const auth = await apiKeyAuthContext(org.id, {
        id: record.id, kind: record.kind, apiVersion: API_VERSION, createdById: owner.id, scopes: record.scopes, projectIds: record.projectIds,
      });
      if (!auth) throw new Error("key owner is not a member");
      return auth;
    }

    /** The session-shaped context `getAuthContext` builds for a logged-in OWNER. */
    async function sessionAuth(): Promise<AuthContext> {
      const eff = await loadEffectivePermissions(org.id, owner.id);
      if (!eff) throw new Error("owner is not a member");
      return {
        userId: owner.id, orgId: org.id, orgRole: eff.orgRole,
        permissions: eff.permissions, basePermissions: eff.basePermissions, abacRules: eff.abacRules,
      };
    }

    const toolCtx = (auth: AuthContext) => ({ orgId: org.id, userId: owner.id, auth });
    return { org, owner, projectA, projectB, itemA, itemB, keyAuth, sessionAuth, toolCtx };
  }

  const exists = async (id: string) => (await prisma.workItem.count({ where: { id } })) === 1;

  describe("read-only key", () => {
    it("cannot execute delete_work_item through the tool executor", async () => {
      const s = await setup();
      const auth = await s.keyAuth(["read"]);
      const res = await executeTool("delete_work_item", { itemId: s.itemA.id }, s.toolCtx(auth));
      expect(res).toEqual({ error: "Insufficient permissions" });
      expect(await exists(s.itemA.id)).toBe(true);
    });

    it("cannot create or update work items", async () => {
      const s = await setup();
      const auth = await s.keyAuth(["read"]);
      const created = await executeTool(
        "create_work_item", { projectId: s.projectA.id, title: "should not exist" }, s.toolCtx(auth),
      );
      expect(created).toEqual({ error: "Insufficient permissions" });
      expect(await prisma.workItem.count({ where: { title: "should not exist", orgId: s.org.id } })).toBe(0);

      const updated = await executeTool(
        "update_work_item", { itemId: s.itemA.id, title: "renamed by a read key" }, s.toolCtx(auth),
      );
      expect(updated).toEqual({ error: "Insufficient permissions" });
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id: s.itemA.id } })).title).toBe(s.itemA.title);
    });

    it("can still read", async () => {
      const s = await setup();
      const auth = await s.keyAuth(["read"]);
      const res = (await executeTool("list_work_items", { projectId: s.projectA.id }, s.toolCtx(auth))) as {
        items?: { id: string }[];
      };
      expect(res.items?.map((i) => i.id)).toContain(s.itemA.id);
    });

    it("an items:write key (no ITEM_DELETE) still cannot delete, even though the user is OWNER", async () => {
      const s = await setup();
      const auth = await s.keyAuth(["items:write"]);
      const res = await executeTool("delete_work_item", { itemId: s.itemA.id }, s.toolCtx(auth));
      expect(res).toEqual({ error: "Insufficient permissions" });
      expect(await exists(s.itemA.id)).toBe(true);
    });
  });

  describe("project-limited key", () => {
    it("does not see the other project's items in query_work_items", async () => {
      const s = await setup();
      const auth = await s.keyAuth(["items:write"], [s.projectA.id]);
      const res = (await executeTool("query_work_items", {}, s.toolCtx(auth))) as { id: string }[] | { items?: { id: string }[] };
      const ids = (Array.isArray(res) ? res : (res.items ?? [])).map((i) => i.id);
      expect(ids).toContain(s.itemA.id);
      expect(ids).not.toContain(s.itemB.id);

      const named = await executeTool("query_work_items", { projectId: s.projectB.id }, s.toolCtx(auth));
      expect(named).toEqual({ error: "Project not found" });
    });

    it("cannot list or enumerate the other project", async () => {
      const s = await setup();
      const auth = await s.keyAuth(["items:write"], [s.projectA.id]);
      const list = await executeTool("list_work_items", { projectId: s.projectB.id }, s.toolCtx(auth));
      expect(list).toEqual({ error: "Project not found" });

      const projects = JSON.stringify(await executeTool("list_projects", {}, s.toolCtx(auth)));
      expect(projects).toContain(s.projectA.id);
      expect(projects).not.toContain(s.projectB.id);
    });

    it("cannot write to the other project", async () => {
      const s = await setup();
      const auth = await s.keyAuth(["items:write"], [s.projectA.id]);
      const updated = await executeTool(
        "update_work_item", { itemId: s.itemB.id, title: "renamed across the fence" }, s.toolCtx(auth),
      );
      expect(updated).toEqual({ error: "Work item not found" });
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id: s.itemB.id } })).title).toBe(s.itemB.title);

      const created = (await executeTool(
        "create_work_item", { projectId: s.projectB.id, title: "planted in bravo" }, s.toolCtx(auth),
      )) as { error?: string };
      expect(created.error).toBeTruthy();
      expect(await prisma.workItem.count({ where: { projectId: s.projectB.id, title: "planted in bravo" } })).toBe(0);
    });

    it("can still write inside its own project", async () => {
      const s = await setup();
      const auth = await s.keyAuth(["items:write"], [s.projectA.id]);
      const updated = (await executeTool(
        "update_work_item", { itemId: s.itemA.id, title: "renamed in scope" }, s.toolCtx(auth),
      )) as { error?: string };
      expect(updated.error).toBeUndefined();
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id: s.itemA.id } })).title).toBe("renamed in scope");
    });
  });

  describe("session user (regression)", () => {
    it("keeps full access: sees both projects and can delete", async () => {
      const s = await setup();
      const auth = await s.sessionAuth();
      const res = (await executeTool("query_work_items", {}, s.toolCtx(auth))) as { id: string }[] | { items?: { id: string }[] };
      const ids = (Array.isArray(res) ? res : (res.items ?? [])).map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([s.itemA.id, s.itemB.id]));

      const del = (await executeTool("delete_work_item", { itemId: s.itemB.id }, s.toolCtx(auth))) as { deleted?: boolean };
      expect(del.deleted).toBe(true);
      expect(await exists(s.itemB.id)).toBe(false);
    });
  });

  describe("missing caller context", () => {
    it("is refused rather than falling back to the user's full permissions", async () => {
      const s = await setup();
      const bare = { orgId: s.org.id, userId: s.owner.id } as unknown as Parameters<typeof executeTool>[2];
      expect(await executeTool("delete_work_item", { itemId: s.itemA.id }, bare)).toEqual({
        error: "Insufficient permissions",
      });
      expect(await exists(s.itemA.id)).toBe(true);
      expect(await executeTool("query_work_items", {}, bare)).toEqual({ error: "Insufficient permissions" });
    });

    it("is refused when the context belongs to a different org or user", async () => {
      const s = await setup();
      const auth = await s.sessionAuth();
      const wrongOrg = { orgId: s.org.id, userId: s.owner.id, auth: { ...auth, orgId: crypto.randomUUID() } };
      expect(await executeTool("delete_work_item", { itemId: s.itemA.id }, wrongOrg)).toEqual({
        error: "Insufficient permissions",
      });
      const wrongUser = { orgId: s.org.id, userId: s.owner.id, auth: { ...auth, userId: crypto.randomUUID() } };
      expect(await executeTool("delete_work_item", { itemId: s.itemA.id }, wrongUser)).toEqual({
        error: "Insufficient permissions",
      });
      expect(await exists(s.itemA.id)).toBe(true);
    });
  });
});
