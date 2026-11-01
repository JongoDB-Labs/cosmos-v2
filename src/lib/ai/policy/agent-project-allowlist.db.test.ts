// @vitest-environment node
//
// THE BUG REPLAY, end to end against a real database.
//
// An org can restrict Cosmo to named projects (Settings → agent policy → `allowedProjectIds`,
// served by /api/v1/orgs/[orgId]/agent-policy). That allowlist was enforced in ONE place:
// `checkAgentPolicy`'s arg axis, which reads `args.projectId`. So it bound only the tools
// that happen to take a project, and only when the model chose to pass one.
//
// `get_work_item` takes ONLY `itemId`. There is no `projectId` to compare, so the axis never
// fired and the allowlist did not apply to the single widest read Cosmo has — the full
// ticket body, description included.
//
// These specs drive the REAL executor against REAL rows so the whole chain runs:
//   narrowAuthToPolicyProjects → AuthContext.projectScope → requireProjectRead
//     → isProjectVisible → inKeyProjectScope
// A spec that mocked `requireProjectRead` would assert the call and prove nothing about
// whether the ceiling actually binds.
//
// THE ACTOR IS AN OWNER ON PURPOSE. `isProjectVisible` and `getReadableProjectIds` both
// short-circuit to "every project" for an owner and for org administrators. A ceiling
// evaluated after that branch would be decorative for exactly the people who configure one,
// so an owner is the only actor that proves the ceiling is checked ahead of the role.
//
// Needs the local e2e DB: DATABASE_URL=postgresql://ci:ci@localhost:5441/ci
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { getWorkItem } from "@/lib/ai/executors/work-items";
import { executeTool } from "@/lib/ai/tool-executor";
import { narrowAuthToPolicyProjects } from "./project-scope";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import type { ToolContext } from "@/lib/ai/executors/_ctx";

describe("agent policy project allowlist binds tools that take no projectId (e2e DB)", () => {
  const cleanup: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup } } }).catch(() => undefined);
  });

  let allowedProjectId: string;
  let excludedProjectId: string;
  let itemInAllowed: string;
  let itemInExcluded: string;
  /** The caller as the route authenticated them: an OWNER, no policy applied yet. */
  let ownerCtx: ToolContext;

  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `agent-scope ${stamp}`, slug: `agent-scope-${stamp}` },
    });
    cleanup.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: alice.id, role: "OWNER" } });

    // Neither project opts into teamScopedAccess: the allowlist must bind on ORDINARY
    // projects an owner can plainly see, not only on ones already restricted another way.
    // A work item's `columnKey` is an FK onto WorkflowStatus(projectId, key), so each
    // project needs its own "todo" status before an item can exist in it.
    const mk = async (key: string, name: string) => {
      const { id } = await prisma.project.create({ data: { orgId: org.id, key, name } });
      await prisma.workflowStatus.create({
        data: { orgId: org.id, projectId: id, key: "todo", name: "To do", category: "TODO" },
      });
      return id;
    };
    allowedProjectId = await mk(`AL${stamp.slice(-4)}`, "Allowed project");
    excludedProjectId = await mk(`EX${stamp.slice(-4)}`, "Excluded project");

    const type = await prisma.workItemType.create({
      data: { orgId: org.id, key: `task-${stamp.slice(-4)}`, name: "Task" },
    });
    const mkItem = async (projectId: string, n: number, title: string) =>
      (await prisma.workItem.create({
        data: {
          orgId: org.id, projectId, workItemTypeId: type.id, ticketNumber: n,
          title, description: "Body the agent can read back.",
          columnKey: "todo", createdById: alice.id,
        },
      })).id;
    itemInAllowed = await mkItem(allowedProjectId, 1, "in-allowed");
    itemInExcluded = await mkItem(excludedProjectId, 2, "in-excluded");

    ownerCtx = await memberToolCtx(org.id, alice.id);
    expect(ownerCtx.auth).toBeDefined();
  });

  /** A ToolContext as the agent loop builds it: the caller's auth, narrowed by the policy. */
  const underPolicy = (allowlist: string[] | null): ToolContext => ({
    ...ownerCtx,
    auth: narrowAuthToPolicyProjects(ownerCtx.auth!, allowlist),
  });

  const read = (itemId: string, ctx: ToolContext) =>
    getWorkItem({ itemId }, ctx) as Promise<{ id?: string; title?: string; error?: string }>;

  // ── POSITIVE CONTROL ────────────────────────────────────────────────────────────
  // Without this, every assertion below could pass because the row is unreachable for
  // some reason that has nothing to do with the allowlist, and the suite would be green
  // over a feature that never worked.
  it("CONTROL: with no allowlist, the owner reads the excluded project's item in full", async () => {
    const out = await read(itemInExcluded, underPolicy(null));
    expect(out.error).toBeUndefined();
    expect(out.id).toBe(itemInExcluded);
    expect(out.title).toBe("in-excluded");
  });

  it("refuses get_work_item for an item OUTSIDE the allowlist — the tool names no project", async () => {
    const out = await read(itemInExcluded, underPolicy([allowedProjectId]));
    expect(out.error).toBe("Work item not found");
    expect(out.id).toBeUndefined();
    // The body is the thing the allowlist exists to withhold; assert it explicitly rather
    // than trusting that an `error` key means nothing else came back.
    expect(out).not.toHaveProperty("description");
  });

  it("still serves an item INSIDE the allowlist (it narrows, it does not break the tool)", async () => {
    const out = await read(itemInAllowed, underPolicy([allowedProjectId]));
    expect(out.error).toBeUndefined();
    expect(out.id).toBe(itemInAllowed);
  });

  it("refuses with the SAME message as a missing row, so a refusal confirms nothing", async () => {
    const real = await read(itemInExcluded, underPolicy([allowedProjectId]));
    const absent = await read("99999999-9999-4999-a999-999999999999", underPolicy([allowedProjectId]));
    expect(real.error).toBe(absent.error);
  });

  it("an EMPTY allowlist reaches nothing — it is not read as 'no restriction'", async () => {
    const a = await read(itemInAllowed, underPolicy([]));
    const b = await read(itemInExcluded, underPolicy([]));
    expect(a.error).toBe("Work item not found");
    expect(b.error).toBe("Work item not found");
  });

  // `query_work_items` is the cross-project read: its `projectId` is OPTIONAL, and omitting
  // it used to mean "every project in the org". That omission was the second way past the
  // old arg-axis check — nothing to compare, so nothing refused. Driven through
  // `executeTool`, the real dispatch entry point, rather than the executor directly.
  it("bounds the cross-project ENUMERATION path, where projectId was simply omitted", async () => {
    const titles = async (ctx: ToolContext) => {
      const out = (await executeTool("query_work_items", {}, ctx)) as {
        items?: { title: string }[]; error?: string;
      };
      expect(out.error).toBeUndefined();
      return (out.items ?? []).map((i) => i.title).sort();
    };

    // Control: unrestricted, omitting projectId really does return both projects' items.
    expect(await titles(underPolicy(null))).toEqual(["in-allowed", "in-excluded"]);

    // Under the allowlist, the same argument-free call sees only the allowed project.
    expect(await titles(underPolicy([allowedProjectId]))).toEqual(["in-allowed"]);

    // And an empty allowlist enumerates nothing.
    expect(await titles(underPolicy([]))).toEqual([]);
  });
});
