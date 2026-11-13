// @vitest-environment node
//
// Cosmo's objective-dependency tools answer exactly as the REST route does:
// they call the same service, so the same org, visibility, self and loop rules
// hold, and list_objectives reports what each objective depends on and whether
// it is overdue.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import type { ToolContext } from "./_ctx";
import { addObjectiveDependency, listObjectives, removeObjectiveDependency } from "./okrs";
import { DEPENDENCY_LOOP, SELF_DEPENDENCY } from "@/lib/okr/dependencies.server";

const stamp = Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;
const ids: Record<string, string> = {};
const users: string[] = [];
let member: ToolContext;
let insider: ToolContext;
let outsider: ToolContext;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `cdep ${stamp}`, slug: `cdep-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `cdep2 ${stamp}`, slug: `cdep2-${stamp}` } });
  ids.org = org.id;
  ids.other = other.id;
  const person = async (name: string) => {
    const id = (await prisma.user.create({ data: { email: `${name}-${stamp}@cdep.test`, displayName: name } })).id;
    users.push(id);
    return { id, om: (await prisma.orgMember.create({ data: { orgId: org.id, userId: id, role: "MEMBER" } })).id };
  };
  const m = await person("member");
  const i = await person("insider");
  const project = (orgId: string, key: string, teamScopedAccess = false) =>
    prisma.project.create({ data: { orgId, name: `${key} ${stamp}`, key: `${key}${stamp}`.toUpperCase().slice(0, 7), teamScopedAccess } });
  const one = await project(org.id, "C");
  const two = await project(org.id, "D");
  const sec = await project(org.id, "E", true);
  const far = await project(other.id, "F");
  await prisma.projectMember.create({ data: { projectId: sec.id, orgMemberId: i.om } });
  const today = Math.floor(Date.now() / DAY) * DAY;
  const objective = async (orgId: string, projectId: string, title: string, targetDate?: Date) =>
    (await prisma.objective.create({ data: { orgId, projectId, title: `${title} ${stamp}`, targetDate } })).id;
  ids.a = await objective(org.id, one.id, "a");
  ids.b = await objective(org.id, two.id, "b", new Date(today - DAY));
  ids.secret = await objective(org.id, sec.id, "secret");
  ids.secretWaits = await objective(org.id, sec.id, "secret waits");
  ids.c = await objective(org.id, one.id, "c");
  ids.foreign = await objective(other.id, far.id, "foreign");
  ids.one = one.id;
  member = await memberToolCtx(org.id, m.id);
  insider = await memberToolCtx(org.id, i.id);
  outsider = await memberToolCtx(org.id, "00000000-0000-0000-0000-000000000000");
});

afterAll(async () => {
  for (const orgId of [ids.org, ids.other]) {
    await prisma.objectiveDependency.deleteMany({ where: { orgId } });
    await prisma.objective.deleteMany({ where: { orgId } });
    await prisma.projectMember.deleteMany({ where: { project: { orgId } } });
    await prisma.project.deleteMany({ where: { orgId } });
    await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  }
  await prisma.organization.deleteMany({ where: { id: { in: [ids.org, ids.other] } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

type Listed = { objectives: Array<{ id: string; overdue: boolean; dependsOn: Array<{ id: string; overdue: boolean }> }> };

describe("Cosmo's objective dependency tools", () => {
  it("add one across projects, and list_objectives shows it with the overdue flag (positive control)", async () => {
    const res = (await addObjectiveDependency({ objectiveId: ids.a, dependsOnId: ids.b }, member)) as Record<string, unknown>;
    expect(res).toMatchObject({ added: true, dependency: { objectiveId: ids.a, dependsOnId: ids.b } });
    const list = (await listObjectives({}, member)) as Listed;
    expect(list.objectives.find((o) => o.id === ids.a)?.dependsOn).toMatchObject([{ id: ids.b, overdue: true }]);
    expect(list.objectives.find((o) => o.id === ids.b)?.overdue).toBe(true);
    expect(list.objectives.find((o) => o.id === ids.a)?.overdue).toBe(false);
  });

  it("refuse another org's objective, in the route's words", async () => {
    expect(await addObjectiveDependency({ objectiveId: ids.a, dependsOnId: ids.foreign }, member)).toEqual({
      error: "That objective doesn't exist in this organization.",
    });
  });

  it("refuse a team-scoped project's objective off the team, and allow it on the team", async () => {
    expect(await addObjectiveDependency({ objectiveId: ids.a, dependsOnId: ids.secret }, member)).toEqual({
      error: "That objective doesn't exist in this organization.",
    });
    expect(await addObjectiveDependency({ objectiveId: ids.a, dependsOnId: ids.secret }, insider)).toMatchObject({ added: true });
    // Off the team, the board leaves it out.
    const list = (await listObjectives({ projectId: ids.one }, member)) as Listed;
    expect(list.objectives.find((o) => o.id === ids.a)?.dependsOn.map((d) => d.id)).toEqual([ids.b]);
    expect(await removeObjectiveDependency({ objectiveId: ids.a, dependsOnId: ids.secret }, insider)).toMatchObject({ removed: true });
  });

  it("refuse itself and a loop", async () => {
    expect(await addObjectiveDependency({ objectiveId: ids.a, dependsOnId: ids.a }, member)).toEqual({ error: SELF_DEPENDENCY });
    expect(await addObjectiveDependency({ objectiveId: ids.b, dependsOnId: ids.a }, member)).toEqual({ error: DEPENDENCY_LOOP });
  });

  it("refuse a non-member outright", async () => {
    expect(await addObjectiveDependency({ objectiveId: ids.a, dependsOnId: ids.b }, outsider)).toHaveProperty("error");
    expect(await removeObjectiveDependency({ objectiveId: ids.a, dependsOnId: ids.b }, outsider)).toHaveProperty("error");
    expect(await prisma.objectiveDependency.count({ where: { objectiveId: ids.a } })).toBe(1);
  });

  it("refuse to add from, or remove from, an objective in a project the actor can't see", async () => {
    const count = () => prisma.objectiveDependency.count({ where: { objectiveId: ids.secretWaits } });
    expect(await addObjectiveDependency({ objectiveId: ids.secretWaits, dependsOnId: ids.c }, member)).toEqual({ error: "Objective not found" });
    expect(await count()).toBe(0);
    // Control: on the team, the same edge is added.
    expect(await addObjectiveDependency({ objectiveId: ids.secretWaits, dependsOnId: ids.c }, insider)).toMatchObject({ added: true });
    expect(await removeObjectiveDependency({ objectiveId: ids.secretWaits, dependsOnId: ids.c }, member)).toEqual({ error: "Objective not found" });
    expect(await count()).toBe(1);
    expect(await removeObjectiveDependency({ objectiveId: ids.secretWaits, dependsOnId: ids.c }, insider)).toMatchObject({ removed: true });
    expect(await count()).toBe(0);
  });

  it("remove nothing pointing at an objective the actor can't see, in the words used when there is none", async () => {
    expect(await addObjectiveDependency({ objectiveId: ids.c, dependsOnId: ids.secret }, insider)).toMatchObject({ added: true });
    const none = await removeObjectiveDependency({ objectiveId: ids.c, dependsOnId: ids.a }, member);
    expect(none).toHaveProperty("error");
    expect(await removeObjectiveDependency({ objectiveId: ids.c, dependsOnId: ids.secret }, member)).toEqual(none);
    expect(await prisma.objectiveDependency.count({ where: { objectiveId: ids.c } })).toBe(1);
    expect(await removeObjectiveDependency({ objectiveId: ids.c, dependsOnId: ids.secret }, insider)).toMatchObject({ removed: true });
  });

  it("remove one, and say so when there was none", async () => {
    expect(await removeObjectiveDependency({ objectiveId: ids.a, dependsOnId: ids.b }, member)).toMatchObject({ removed: true });
    expect(await removeObjectiveDependency({ objectiveId: ids.a, dependsOnId: ids.b }, member)).toHaveProperty("error");
  });
});
