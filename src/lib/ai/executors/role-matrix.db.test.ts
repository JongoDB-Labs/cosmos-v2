// @vitest-environment node
//
// THE ROLE MATRIX, exercised against a real database.
//
// Everything else proving the agent's RBAC either stubs the actor's permissions
// (`stubAuth`) or asserts on source text (the arch rules). Both were enough to
// FIND the defects fixed in 2.499.2 and 2.500.0 and neither can show that a
// real person with a real org role and a real project membership gets the
// answer the app would give them. This file does that: every context here comes
// from `memberToolCtx`, which reads the actor's AuthContext out of the database
// exactly as a logged-in session would.
//
// The case that matters is the one 2.500.0 fixed and nothing could demonstrate:
// a MEMBER who is MANAGER of a project. They hold no org-wide PROJECT_UPDATE,
// so a raw `assertPermission` pre-check refused them while the project's own
// pages let them work — and `requireProjectManage` admits them by its second
// branch. Proving that needs a ProjectMember row with role MANAGER, which is
// not something a stub can fake.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { createMilestone, listMilestones } from "./milestones";
import { createRisk } from "./pm-register";
import { createKpi } from "./goals-kpis";
import { listTimeEntries } from "./time";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import type { ToolContext } from "@/lib/ai/executors/_ctx";

const DUE = "2026-12-01T00:00:00.000Z";

describe("agent role matrix (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  let managerCtx: ToolContext;   // MEMBER + MANAGER of `managed`
  let plainCtx: ToolContext;     // MEMBER, manages nothing
  let ownerCtx: ToolContext;
  let managed: { id: string };
  let unmanaged: { id: string };

  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const bob = await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } });
    const carol = await prisma.user.findFirstOrThrow({ where: { email: "carol@test.local" } });

    const org = await prisma.organization.create({
      data: { name: `role-matrix ${stamp}`, slug: `role-matrix-${stamp}` },
    });
    cleanup.orgIds.push(org.id);

    await prisma.orgMember.create({ data: { orgId: org.id, userId: alice.id, role: "OWNER" } });
    const bobMember = await prisma.orgMember.create({
      data: { orgId: org.id, userId: bob.id, role: "MEMBER" },
    });
    await prisma.orgMember.create({ data: { orgId: org.id, userId: carol.id, role: "MEMBER" } });

    const k = stamp.slice(-4).toUpperCase();
    managed = await prisma.project.create({ data: { orgId: org.id, name: "Managed", key: `RMA${k}` } });
    unmanaged = await prisma.project.create({ data: { orgId: org.id, name: "Other", key: `RMB${k}` } });

    // Bob MANAGES one project and merely belongs to the org for the other. This
    // is the whole point: `ProjectMember.orgMemberId` is an OrgMember.id, not a
    // User.id — getting that wrong silently produces a non-manager and the
    // spec would "pass" by refusing for the wrong reason.
    await prisma.projectMember.create({
      data: { projectId: managed.id, orgMemberId: bobMember.id, role: "MANAGER" },
    });

    managerCtx = await memberToolCtx(org.id, bob.id);
    plainCtx = await memberToolCtx(org.id, carol.id);
    ownerCtx = await memberToolCtx(org.id, alice.id);
  });

  it("the fixture is what it claims: a MEMBER without org-wide PROJECT_UPDATE", async () => {
    // Guards every assertion below. If bob turned out to hold PROJECT_UPDATE
    // org-wide, the manager-branch tests would pass through the FIRST branch of
    // `requireProjectManage` and demonstrate nothing.
    expect(managerCtx.auth?.orgRole).toBe("MEMBER");
    expect(hasPermission(managerCtx.auth!.permissions, Permission.PROJECT_UPDATE)).toBe(false);
    expect(hasPermission(plainCtx.auth!.permissions, Permission.PROJECT_UPDATE)).toBe(false);
    // And the owner does hold it, so the comparison has a working upper bound.
    expect(hasPermission(ownerCtx.auth!.permissions, Permission.PROJECT_UPDATE)).toBe(true);
  });

  describe("a MEMBER who MANAGES the project", () => {
    it("can create a milestone — the 2.500.0 fix, demonstrated", async () => {
      const out = (await createMilestone(
        { projectId: managed.id, title: "Manager milestone", dueDate: DUE },
        managerCtx,
      )) as { created?: boolean; id?: string; error?: string };

      expect(out.error).toBeUndefined();
      expect(out.created).toBe(true);
      // The row, not the message: this is the assertion the stubs could not make.
      expect(await prisma.milestone.count({ where: { projectId: managed.id } })).toBe(1);
    });

    it("can create a risk and a KPI on it too", async () => {
      const risk = (await createRisk(
        { projectId: managed.id, title: "Manager risk", likelihood: 3, impact: 3 },
        managerCtx,
      )) as { created?: boolean; error?: string };
      expect(risk.error).toBeUndefined();
      expect(risk.created).toBe(true);

      // create_kpi is the one whose org-wide bit was WRONG before (OKR_CREATE,
      // which MEMBER holds, where the route wants PROJECT_UPDATE). It must now
      // admit this actor via the manager branch, not via a weaker bit.
      const kpi = (await createKpi(
        { projectId: managed.id, name: "Velocity", target: 10 },
        managerCtx,
      )) as { created?: boolean; error?: string };
      expect(kpi.error).toBeUndefined();
      expect(kpi.created).toBe(true);
    });

    it("CANNOT create a milestone on a project they do not manage", async () => {
      // The fix must not have widened past the project. Bob can SEE this
      // project (PROJECT_READ is MEMBER-held and it is not team-scoped), so the
      // refusal is about authority, and its message says so rather than hiding
      // the project.
      const out = (await createMilestone(
        { projectId: unmanaged.id, title: "Nope", dueDate: DUE },
        managerCtx,
      )) as { created?: boolean; error?: string };

      expect(out.created).toBeUndefined();
      expect(out.error).toMatch(/permission/i);
      expect(await prisma.milestone.count({ where: { projectId: unmanaged.id } })).toBe(0);
    });
  });

  describe("a plain MEMBER who manages nothing", () => {
    it("is refused, and writes nothing", async () => {
      const out = (await createMilestone(
        { projectId: managed.id, title: "Nope", dueDate: DUE },
        plainCtx,
      )) as { created?: boolean; error?: string };

      expect(out.created).toBeUndefined();
      expect(out.error).toBeDefined();
      // Only the manager's milestone exists.
      expect(await prisma.milestone.count({ where: { projectId: managed.id, title: "Nope" } })).toBe(0);
    });

    it("can still READ the project's milestones", async () => {
      // The refusal above must be about WRITING. A member who cannot read their
      // own org's project would be a different bug, and a write-refusal spec
      // that also happened to be a read-refusal would hide it.
      //
      // Seeds its OWN row rather than relying on the manager spec above having
      // run. Mutation testing caught that dependency: reverting the 2.500.0 fix
      // failed this spec too, purely because the earlier write never happened —
      // a cascade that obscures which assertion actually broke, and that breaks
      // outright under `-t` filtering or a reordering.
      await createMilestone(
        { projectId: managed.id, title: "Readable", dueDate: DUE },
        ownerCtx,
      );

      const out = (await listMilestones({ projectId: managed.id }, plainCtx)) as {
        count?: number;
        error?: string;
      };
      expect(out.error).toBeUndefined();
      expect(out.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe("list_time_entries project scope (2.499.2)", () => {
    it("accepts a project this actor may open", async () => {
      const out = (await listTimeEntries({ projectId: managed.id }, plainCtx)) as {
        entries?: unknown[];
        error?: string;
      };
      expect(out.error).toBeUndefined();
    });

    it("refuses a project id from ANOTHER org", async () => {
      // The gate this release added. Before it, a caller-supplied projectId was
      // applied to the WHERE clause unchecked — the scope helper only ever
      // constrained WHOSE hours, never which project.
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const other = await prisma.organization.create({
        data: { name: `rm-other ${stamp}`, slug: `rm-other-${stamp}` },
      });
      cleanup.orgIds.push(other.id);
      const foreign = await prisma.project.create({
        data: { orgId: other.id, name: "Foreign", key: `RMF${stamp.slice(-4).toUpperCase()}` },
      });

      const out = (await listTimeEntries({ projectId: foreign.id }, plainCtx)) as {
        entries?: unknown[];
        error?: string;
      };
      expect(out.error).toBeDefined();
    });
  });

  it("the OWNER can do all of it, so none of the refusals are the tool being broken", async () => {
    const out = (await createMilestone(
      { projectId: unmanaged.id, title: "Owner milestone", dueDate: DUE },
      ownerCtx,
    )) as { created?: boolean; error?: string };

    expect(out.error).toBeUndefined();
    expect(out.created).toBe(true);
  });
});
