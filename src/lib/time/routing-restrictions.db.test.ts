// @vitest-environment node
//
// Who is asked to approve a timesheet, and who may be named a supervisor, when
// the org has restricted approving time.
//
// An org restriction with no conditions takes its permission away from every
// member (loadEffectivePermissions). `approversInOrg` asks the same question of
// a whole org at once, from the member rows, and used to fold role, override
// and work-role grants by hand without the restriction: a person the org had
// stopped from approving time was still handed timesheets, and still offered
// as a supervisor. These run the real queries against a real database. Own org
// and users throughout; the seeded users are shared.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/client";
import { Permission, hasPermission, maskToDb } from "@/lib/rbac/permissions";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { approversInOrg } from "./routing";
import { assignableSupervisors, supervisorPickerOptions } from "@/lib/org/assignable-supervisors";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "";
const users: string[] = [];

/** Everyone who holds TIME_APPROVE, each by a different route, plus the worker who holds none. */
const people = {
  owner: { userId: "", employeeId: "" },
  admin: { userId: "", employeeId: "" },
  viaWorkRole: { userId: "", employeeId: "" },
  viaOverride: { userId: "", employeeId: "" },
  worker: { userId: "", employeeId: "" },
};
type Who = keyof typeof people;
const holders: Who[] = ["owner", "admin", "viaWorkRole", "viaOverride"];
const ids = (who: Who[]) => who.map((w) => people[w].userId).sort();

const UNCONDITIONAL = [{ effect: "deny", actions: ["TIME_APPROVE"], conditions: [] }];
const CONDITIONAL = [{ effect: "deny", actions: ["TIME_APPROVE"], conditions: [{ rel: "owns_resource" }] }];
const UNRELATED = [{ effect: "deny", actions: ["ITEM_DELETE"], conditions: [] }];

async function restrict(actionRestrictions: unknown[]) {
  await prisma.orgSecuritySettings.upsert({
    where: { orgId },
    create: { orgId, actionRestrictions: actionRestrictions as never },
    update: { actionRestrictions: actionRestrictions as never },
  });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Routing ${stamp}`, slug: `rtr-${stamp}` } })).id;
  const approverRole = await prisma.workRole.create({
    data: { orgId, key: `approver-${stamp}`, name: "Approver", grants: maskToDb(Permission.TIME_APPROVE) },
  });

  const shape: Record<Who, { role: "OWNER" | "ADMIN" | "MEMBER"; permissions: string; workRole?: boolean }> = {
    owner: { role: "OWNER", permissions: "0" },
    admin: { role: "ADMIN", permissions: "0" },
    viaWorkRole: { role: "MEMBER", permissions: "0", workRole: true },
    viaOverride: { role: "MEMBER", permissions: maskToDb(Permission.TIME_APPROVE) },
    worker: { role: "MEMBER", permissions: "0" },
  };
  for (const [who, s] of Object.entries(shape) as [Who, (typeof shape)[Who]][]) {
    const userId = (await prisma.user.create({ data: { email: `${who}-${stamp}@routing.test`, displayName: `${who} ${stamp}` } })).id;
    users.push(userId);
    const member = await prisma.orgMember.create({ data: { orgId, userId, role: s.role, permissions: s.permissions } });
    if (s.workRole) {
      await prisma.orgMemberWorkRole.create({ data: { orgMemberId: member.id, workRoleId: approverRole.id } });
    }
    // The owner comes first, and records everyone's employee row.
    const createdById = people.owner.userId || userId;
    const employeeId = (await prisma.employee.create({ data: { orgId, userId, costRate: 50, createdById } })).id;
    people[who] = { userId, employeeId };
  }
  // The admin already supervises the worker: a restriction must leave that
  // assignment visible and removable, never offered as a new one.
  await prisma.employeeSupervisor.create({
    data: { orgId, employeeId: people.worker.employeeId, supervisorId: people.admin.employeeId, createdById: people.owner.userId },
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
});

const supervisorChoices = async () =>
  (await assignableSupervisors(orgId, people.worker.employeeId)).map((c) => c.userId).sort();

describe("approvers and supervisor candidates follow the org's restrictions", () => {
  it("without a restriction, everyone who holds TIME_APPROVE is asked and can be named", async () => {
    await restrict([]);
    expect((await approversInOrg(orgId)).sort()).toEqual(ids(holders));
    expect(await supervisorChoices()).toEqual(ids(holders));
  });

  it("an unconditional TIME_APPROVE restriction removes every one of them, the owner included", async () => {
    await restrict(UNCONDITIONAL);
    expect(await approversInOrg(orgId)).toEqual([]);
    expect(await supervisorChoices()).toEqual([]);

    // The existing supervisor stays listed so the assignment can be removed,
    // marked as no longer able to approve, and is not offered as a new one.
    const picker = await supervisorPickerOptions(orgId, people.worker.employeeId);
    expect(picker.addableIds).toEqual([]);
    expect(picker.options).toEqual([expect.objectContaining({ userId: people.admin.userId, canApprove: false })]);
  });

  it("a restriction with conditions, or on another action, removes nobody here", async () => {
    // A conditional restriction applies where a check names the resource, as
    // in loadEffectivePermissions; it does not take the bit away outright.
    for (const rules of [CONDITIONAL, UNRELATED]) {
      await restrict(rules);
      expect((await approversInOrg(orgId)).sort()).toEqual(ids(holders));
      expect(await supervisorChoices()).toEqual(ids(holders));
    }
  });

  it("agrees, person by person, with what loadEffectivePermissions gives them outside an owner's session", async () => {
    for (const rules of [[], UNCONDITIONAL, CONDITIONAL]) {
      await restrict(rules);
      const approvers = new Set(await approversInOrg(orgId));
      let compared = 0;
      for (const who of Object.keys(people) as Who[]) {
        const eff = await loadEffectivePermissions(orgId, people[who].userId, { forApiKey: true });
        expect(eff, who).not.toBeNull();
        expect(approvers.has(people[who].userId), `${who} under ${JSON.stringify(rules)}`).toBe(
          hasPermission(eff!.permissions, Permission.TIME_APPROVE),
        );
        compared++;
      }
      expect(compared).toBe(5);
    }
  });
});
