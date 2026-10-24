// (e2e DB) Two-phase sort: ORDER BY assignee / status / project / custom
// fields, which run as SQL over the matching ids (query design §6.4).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OrgRole, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { executeCql, exportCql } from "../execute.server";
import { CqlError } from "../errors";
import { SORT_MAX } from "../sort.server";
import { seedWorld, type World } from "./cql-fixture";

describe("CQL two-phase sort (e2e DB)", () => {
  let w: World;
  let num: string;
  beforeAll(async () => {
    w = await seedWorld();
    num = `num_${w.stamp}`;
    await prisma.customField.create({ data: { orgId: w.orgA, key: num, name: `Size ${w.stamp}`, fieldType: "NUMBER" } });
    const at = (title: string, value: unknown) =>
      prisma.workItem.update({
        where: { id: w.items[title].id },
        data: { customFields: (value === undefined ? {} : { [num]: value }) as Prisma.InputJsonValue },
      });
    await at("p1-unassigned", 10);
    await at("p1-coowned", 2);
    // Not a number: sorts as empty rather than failing the query.
    await at("p1-done", "lots");
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const titles = async (cql: string, opts: { ctx?: ReturnType<World["ctx"]>; page?: number; pageSize?: number } = {}) =>
    (await executeCql(opts.ctx ?? w.ctx(), { cql }, { pageSize: opts.pageSize ?? 100, page: opts.page ?? 1 })).data.map((r) => r.title);
  const p1 = () => `project = ${w.P1.key}`;
  // p1-login-bug: Ada, In Progress · p1-done: Bob, Done · the rest unassigned
  // (p1-coowned's Bob is a co-assignee; sorting uses the primary).

  it("assignee: by the primary assignee's name, empty last ascending and first descending", async () => {
    const asc = await titles(`${p1()} ORDER BY assignee`);
    expect(asc.slice(0, 2)).toEqual(["p1-login-bug", "p1-done"]);
    expect(asc.slice(2).sort()).toEqual(["p1-child", "p1-coowned", "p1-unassigned"]);
    const desc = await titles(`${p1()} ORDER BY assignee DESC`);
    expect(desc.slice(-2)).toEqual(["p1-done", "p1-login-bug"]);
    expect(await titles(`${p1()} ORDER BY assignee ASC NULLS FIRST`)).toEqual([...asc.slice(2), ...asc.slice(0, 2)]);
  });

  it("status: by the status's name in the item's project", async () => {
    // Cancelled, Done, In Progress, Review, To Do.
    expect(await titles(`${p1()} ORDER BY status`)).toEqual(["p1-child", "p1-done", "p1-login-bug", "p1-coowned", "p1-unassigned"]);
    // The name is the project's workflow status (where a status lives since
    // workflow P1), not a board column that happens to share its key.
    const s = await prisma.workflowStatus.findUniqueOrThrow({ where: { projectId_key: { projectId: w.P1.id, key: "todo" } } });
    await prisma.workflowStatus.update({ where: { id: s.id }, data: { name: "Aaa backlog" } });
    try {
      expect((await titles(`${p1()} ORDER BY status`))[0]).toBe("p1-unassigned");
    } finally {
      await prisma.workflowStatus.update({ where: { id: s.id }, data: { name: s.name } });
    }
  });

  it("pages of a SQL sort are slices of the whole order", async () => {
    const all = await titles(`${p1()} ORDER BY status`);
    const pages = [1, 2, 3].map((page) => titles(`${p1()} ORDER BY status`, { page, pageSize: 2 }));
    expect((await Promise.all(pages)).flat()).toEqual(all);
  });

  it("mixes with ordinary keys, and custom number fields order numerically", async () => {
    // 2 before 10 (as text, "10" < "2"); "lots" and unset are empty, so last.
    const r = await titles(`${p1()} ORDER BY cf[${num}], key`);
    expect(r.slice(0, 2)).toEqual(["p1-coowned", "p1-unassigned"]);
    expect(r.slice(2)).toEqual(["p1-login-bug", "p1-done", "p1-child"]);
  });

  it("project: by key, and only readable projects", async () => {
    const member = await titles("priority = CRITICAL ORDER BY project");
    expect(member).not.toContain(`Secretitem ${w.stamp} login`);
    const admin = await titles("priority = CRITICAL ORDER BY project", { ctx: w.ctx({ role: OrgRole.ADMIN }) });
    // PA…, PB…, PC… keys share a suffix, so key order is project order.
    expect(admin).toEqual(["p1-login-bug", `Secretitem ${w.stamp} login`, `p3-denied-${w.stamp}`]);
  });

  it("export keeps the same order", async () => {
    const r = await exportCql(w.ctx(), { cql: `${p1()} ORDER BY status DESC` });
    expect(r.data.map((x) => x.title)).toEqual((await titles(`${p1()} ORDER BY status`)).reverse());
  });

  it(`past ${SORT_MAX} matching items it refuses, and says what to do`, async () => {
    await prisma.workItem.createMany({
      data: Array.from({ length: SORT_MAX + 1 }, (_, i) => ({
        orgId: w.orgA, projectId: w.P3.id, ticketNumber: 10_000 + i, title: `bulk ${i}`, description: "", columnKey: "todo",
        workItemTypeId: w.typeTask, createdById: w.actor.id,
      })),
    });
    const admin = w.ctx({ role: OrgRole.ADMIN });
    const err = await executeCql(admin, { cql: `project = ${w.P3.key} ORDER BY assignee` }).catch((e) => e);
    expect(err).toBeInstanceOf(CqlError);
    expect((err as CqlError).diagnostics[0].code).toBe("CQL_SORT_TOO_BROAD");
    // An ordinary sort of the same set is fine.
    expect((await executeCql(admin, { cql: `project = ${w.P3.key} ORDER BY due` }, { pageSize: 5 })).data).toHaveLength(5);
    // An export may return 50,000 rows, so it sorts that many: all of these,
    // in order, hydrated in chunks.
    const exported = await exportCql(admin, { cql: `project = ${w.P3.key} AND summary ~ "bulk" ORDER BY key DESC, assignee` });
    expect(exported.data).toHaveLength(SORT_MAX + 1);
    const tickets = exported.data.map((r) => r.ticketNumber);
    expect(tickets).toEqual([...tickets].sort((a, b) => b - a));
  }, 120_000);
});
