// (e2e DB) `ancestor`, `descendantsOf()` and `milestone` (query design phase 4).
//
// These compile to id sets computed at resolve time, so the scope rules are
// re-proved here: the walk stops at a project the viewer can't read, and a
// milestone in a restricted project is neither named nor counted.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { executeCql } from "../execute.server";
import { CqlError } from "../errors";
import { seedWorld, type World } from "./cql-fixture";

const NOW = new Date("2026-10-15T15:00:00Z");

describe("CQL hierarchy and milestones (e2e DB)", () => {
  let w: World;
  let beta: string;
  let secretMilestone: string;
  beforeAll(async () => {
    w = await seedWorld();
    const A = w.orgA;
    let n = 100;
    const mk = async (name: string, projectId: string, parentId: string | null) => {
      const row = await prisma.workItem.create({
        data: {
          orgId: A, projectId, ticketNumber: n++, title: name, description: "", columnKey: "todo",
          workItemTypeId: w.typeTask, createdById: w.actor.id, parentId,
        },
      });
      return row.id;
    };
    // p1-login-bug (P1) → p1-child (P1) → h-grandchild (P1)
    //                                  → h-secret-child (P2, restricted) → h-under-secret (P1)
    //                   → h-secret-direct (P2, restricted) → h-under-direct (P1)
    // A restricted link right under the root and one mid-chain: both the
    // first step and the recursive step have to stop there.
    await mk("h-grandchild", w.P1.id, w.items["p1-child"].id);
    const secretChild = await mk(`h-secret-child ${w.stamp}`, w.P2.id, w.items["p1-child"].id);
    await mk("h-under-secret", w.P1.id, secretChild);
    const secretDirect = await mk(`h-secret-direct ${w.stamp}`, w.P2.id, w.items["p1-login-bug"].id);
    await mk("h-under-direct", w.P1.id, secretDirect);
    // A cycle (parent_id has no constraint against one): the walk must end.
    const a = await mk("h-cycle-a", w.P1.id, null);
    const b = await mk("h-cycle-b", w.P1.id, a);
    await prisma.workItem.update({ where: { id: a }, data: { parentId: b } });

    const milestone = (projectId: string, title: string) =>
      prisma.milestone.create({ data: { orgId: A, projectId, title, dueDate: new Date("2026-11-01") } });
    beta = (await milestone(w.P1.id, `Beta ${w.stamp}`)).id;
    secretMilestone = (await milestone(w.P2.id, `Secretmilestone ${w.stamp}`)).id;
    await prisma.milestoneLink.createMany({
      data: [
        { milestoneId: beta, workItemId: w.items["p1-coowned"].id },
        { milestoneId: beta, workItemId: w.items[`p2-secret-${w.stamp}`].id },
        // A readable item linked only to a milestone the actor can't see.
        { milestoneId: secretMilestone, workItemId: w.items["p1-unassigned"].id },
      ],
    });
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const titles = async (cql: string, ctx = w.ctx()) =>
    (await executeCql(ctx, { cql }, { now: NOW, pageSize: 100 })).data.map((r) => r.title).sort();
  const login = () => `${w.P1.key}-1`;

  it("ancestor = KEY is everything under it, any depth, in readable projects only", async () => {
    expect(await titles(`ancestor = ${login()}`)).toEqual(["h-grandchild", "p1-child"]);
  });

  it("the walk goes through a restricted project only for someone who can read it", async () => {
    const admin = w.ctx({ role: OrgRole.ADMIN });
    expect(await titles(`ancestor = ${login()}`, admin)).toEqual([
      "h-grandchild", `h-secret-child ${w.stamp}`, `h-secret-direct ${w.stamp}`, "h-under-direct", "h-under-secret", "p1-child",
    ]);
  });

  it("descendantsOf(KEY) matches ancestor = KEY, and combines with other clauses", async () => {
    expect(await titles(`descendantsOf(${login()})`)).toEqual(["h-grandchild", "p1-child"]);
    expect(await titles(`descendantsOf(${login()}) AND statusCategory = cancelled`)).toEqual(["p1-child"]);
    expect(await titles(`NOT descendantsOf(${login()}) AND project = ${w.P1.key} AND text ~ "h-"`)).toEqual([
      "h-cycle-a", "h-cycle-b", "h-under-direct", "h-under-secret",
    ]);
  });

  it("ends on a parent cycle", async () => {
    const a = await prisma.workItem.findFirstOrThrow({ where: { orgId: w.orgA, title: "h-cycle-a" }, select: { ticketNumber: true } });
    expect(await titles(`ancestor = ${w.P1.key}-${a.ticketNumber}`)).toEqual(["h-cycle-a", "h-cycle-b"]);
  });

  it("an item with nothing under it matches nothing", async () => {
    const leaf = w.items["p1-done"].ticketNumber;
    expect(await titles(`ancestor = ${w.P1.key}-${leaf}`)).toEqual([]);
  });

  it("milestone = name: its linked items, still inside the envelope", async () => {
    expect(await titles(`milestone = "Beta ${w.stamp}"`)).toEqual(["p1-coowned"]);
    expect(await titles(`milestone = "${beta}"`)).toEqual(["p1-coowned"]);
  });

  it("milestone IS EMPTY / IS NOT EMPTY count only milestones the viewer can see", async () => {
    expect(await titles(`milestone IS NOT EMPTY`)).toEqual(["p1-coowned"]);
    const empty = await titles(`milestone IS EMPTY AND project = ${w.P1.key}`);
    expect(empty).toContain("p1-unassigned");
    expect(empty).not.toContain("p1-coowned");
    // Someone who reads P2 sees the other milestone, so p1-unassigned has one.
    const admin = w.ctx({ role: OrgRole.ADMIN });
    expect(await titles(`milestone IS NOT EMPTY`, admin)).toEqual([`Secretitem ${w.stamp} login`, "p1-coowned", "p1-unassigned"]);
    expect(await titles(`milestone = "Secretmilestone ${w.stamp}"`, admin)).toEqual(["p1-unassigned"]);
    // `!=` leaves out items with no milestone, as on any field.
    expect(await titles(`milestone != "Beta ${w.stamp}"`)).toEqual([]);
    expect(await titles(`milestone != "Beta ${w.stamp}"`, admin)).toEqual(["p1-unassigned"]);
    expect(await titles(`milestone IN ("Beta ${w.stamp}", EMPTY) AND project = ${w.P1.key}`)).toContain("p1-done");
  });

  it("variables (a dashboard's filters) work as the literals they stand for", async () => {
    const withVars = async (cql: string, vars: Record<string, string | string[]>, ctx = w.ctx()) =>
      (await executeCql(ctx, { cql }, { now: NOW, pageSize: 100, vars })).data.map((r) => r.title).sort();
    // Each must equal the literal query, and not be empty: an id set the
    // resolver never gathered makes a variable quietly match nothing.
    const cases: [string, Record<string, string | string[]>, string][] = [
      ["ancestor = $epic", { epic: login() }, `ancestor = ${login()}`],
      ["milestone = $m", { m: `Beta ${w.stamp}` }, `milestone = "Beta ${w.stamp}"`],
      ["milestone IN $ms", { ms: [beta] }, `milestone IN ("${beta}")`],
    ];
    for (const [cql, vars, literal] of cases) {
      const expected = await titles(literal);
      expect(expected.length, literal).toBeGreaterThan(0);
      expect(await withVars(cql, vars), cql).toEqual(expected);
    }
    // `!=` needs every linked item as well as the named one's.
    const admin = w.ctx({ role: OrgRole.ADMIN });
    expect(await withVars("milestone != $m", { m: `Beta ${w.stamp}` }, admin)).toEqual(["p1-unassigned"]);
    // A restricted milestone through a variable is as unknown as typed.
    await expect(withVars("milestone = $m", { m: secretMilestone })).rejects.toThrow(/No milestone named/);
  });

  it("a milestone in a restricted project is unknown, by name and by id, and never named back", async () => {
    for (const v of [`"Secretmilestone ${w.stamp}"`, `"${secretMilestone}"`]) {
      try {
        const r = await executeCql(w.ctx(), { cql: `milestone = ${v}` }, { now: NOW });
        expect(r.total).toBe(0);
        expect(JSON.stringify(r)).not.toContain(`Secretmilestone`);
      } catch (e) {
        expect(e).toBeInstanceOf(CqlError);
        // The error may repeat what the query said, nothing more: by id, never the title.
        if (!v.includes("Secretmilestone")) expect(JSON.stringify((e as CqlError).diagnostics)).not.toContain("Secretmilestone");
      }
    }
  });
});
