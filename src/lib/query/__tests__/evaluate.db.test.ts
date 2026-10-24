// (e2e DB) Conformance (query design §14.2, phase 5): the in-memory
// interpreter (evaluate.ts) over loaded rows agrees with the database on the
// SAME compiled predicate, for generated queries over every field kind.
//
// Every org-A row is evaluated, restricted and archived ones too, so the
// envelope is checked as well as the predicate. With the relations loaded the
// interpreter must decide every row; with board-shaped rows (no comments,
// watchers, label ids or links) it may say UNDECIDED, never the wrong answer.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import { prisma } from "@/lib/db/client";
import { executeCql, predicateCql } from "../execute.server";
import { UNDECIDED, matches } from "../evaluate";
import { seedWorld, type World } from "./cql-fixture";

const NOW = new Date("2026-10-15T15:00:00Z");

describe("evaluate.ts ≡ the database (e2e DB)", () => {
  let w: World;
  let rows: Record<string, unknown>[];
  beforeAll(async () => {
    w = await seedWorld();
    // History for WAS / CHANGED, and a milestone for `milestone =`.
    await prisma.activity.create({
      data: { orgId: w.orgA, workItemId: w.items["p1-done"].id, userId: w.bob.id, action: "updated", field: "columnKey", oldValue: "review", newValue: "done", createdAt: new Date("2026-10-10T12:00:00Z") },
    });
    const m = await prisma.milestone.create({ data: { orgId: w.orgA, projectId: w.P1.id, title: `Beta ${w.stamp}`, dueDate: new Date("2026-11-01") } });
    await prisma.milestoneLink.create({ data: { milestoneId: m.id, workItemId: w.items["p1-coowned"].id } });
    // A literal % in a title, and a custom field stored as JSON null.
    await prisma.workItem.create({
      data: {
        orgId: w.orgA, projectId: w.P1.id, ticketNumber: 77, title: "100% uptime", description: "", columnKey: "todo",
        workItemTypeId: w.typeTask, createdById: w.actor.id, customFields: { [`sev_${w.stamp}`]: null },
      },
    });
    // Every org-A row with the relations the compiler can mention, round-tripped
    // through JSON as a board's fetch would deliver it.
    rows = JSON.parse(
      JSON.stringify(
        await prisma.workItem.findMany({
          where: { orgId: w.orgA },
          include: {
            assignees: { select: { userId: true } },
            labels: { select: { labelId: true } },
            watchers: { select: { userId: true } },
            comments: { select: { content: true } },
            incomingLinks: { select: { type: true, sourceItemId: true } },
            outgoingLinks: { select: { type: true, targetItemId: true } },
            activities: { select: { action: true, field: true, oldValue: true, newValue: true, userId: true, createdAt: true } },
          },
        }),
      ),
    );
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  function clauseArb(): fc.Arbitrary<string> {
    const s = w.stamp;
    const sev = `cf[sev_${s}]`;
    return fc.oneof(
      fc.constantFrom("assignee = me", 'assignee = "Bob Builder"', "assignee IS EMPTY", "assignee != me", "primaryAssignee = me", "reporter = me"),
      fc.constantFrom('sprint = "Sprint 1"', "sprint IN openSprints()", "sprint IS EMPTY", "sprint IN closedSprints()"),
      fc.constantFrom("team = Platform", "team IS EMPTY", "assignee IN membersOf(Platform)"),
      fc.constantFrom("label = auth", "labels IN ALL (auth, urgent)", "label IS EMPTY", "label != urgent"),
      fc.constantFrom(`project = ${w.P1.key}`, `project = ${w.P3.key}`, `project != ${w.P1.key}`),
      fc.constantFrom('status = "In Progress"', "status IN (Review, Done)", "statusCategory = done", "statusCategory != todo", "statusCategory = cancelled"),
      fc.constantFrom("priority >= HIGH", "priority < MEDIUM", "priority IN (LOW, MEDIUM)", "priority != CRITICAL"),
      fc.constantFrom(`parent = ${w.P1.key}-1`, "parent IS EMPTY", `childrenOf(${w.P1.key}-1)`, `ancestor = ${w.P1.key}-1`),
      fc.constantFrom('text ~ "login"', 'summary ~ "p1-"', 'description ~ "LOGIN"', 'comment ~ "x"', 'summary ~ "%"'),
      fc.constantFrom("due < 2026-10-21", "due IS EMPTY", "due IS NOT EMPTY", "due = 2026-10-20", "completed >= -7d", "created > -30d", "updated <= now()"),
      fc.constantFrom("points > 3", "points IS EMPTY", "originalEstimate >= 2h"),
      fc.constantFrom(`${sev} = S1`, `${sev} IS EMPTY`, `${sev} != S2`),
      fc.constantFrom("watcher = me", "watchedItems()", "blocked = true", "blocked = false"),
      fc.constantFrom("workCategory = ENABLER", "highlight = RED", "cancelReason = OBE", "cancelReason IS EMPTY"),
      fc.constantFrom("status WAS Done", "status CHANGED BY \"Bob Builder\"", "status WAS Review AFTER 2026-10-01", `milestone = "Beta ${s}"`, "milestone IS EMPTY"),
    );
  }

  const queryArb = (depth: number): fc.Arbitrary<string> =>
    depth <= 0
      ? clauseArb()
      : fc.oneof(
          { weight: 3, arbitrary: clauseArb() },
          { weight: 1, arbitrary: fc.tuple(queryArb(depth - 1), queryArb(depth - 1)).map(([a, b]) => `(${a}) AND (${b})`) },
          { weight: 1, arbitrary: fc.tuple(queryArb(depth - 1), queryArb(depth - 1)).map(([a, b]) => `(${a}) OR (${b})`) },
          { weight: 1, arbitrary: queryArb(depth - 1).map((a) => `NOT (${a})`) },
        );

  it("decides every fully loaded row exactly as the database does", async () => {
    await fc.assert(
      fc.asyncProperty(queryArb(2), async (cql) => {
        const db = new Set((await executeCql(w.ctx(), { cql }, { now: NOW, pageSize: 100 })).data.map((r) => r.id));
        const { where } = await predicateCql(w.ctx(), { cql }, { now: NOW });
        for (const row of rows) {
          const got = matches(where, row);
          expect(got, `${cql} on ${row.title}`).not.toBe(UNDECIDED);
          expect(got, `${cql} on ${row.title}`).toBe(db.has(row.id as string));
        }
      }),
      { numRuns: 300 },
    );
  }, 300_000);

  it("on board-shaped rows it is undecided rather than wrong, and decides the card fields", async () => {
    // What a board row carries: the card's own columns and its assignee set.
    const RELATIONS = ["labels", "watchers", "comments", "incomingLinks", "outgoingLinks", "activities"];
    const board = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !RELATIONS.includes(k))) as typeof r);
    let decided = 0;
    let total = 0;
    await fc.assert(
      fc.asyncProperty(queryArb(1), async (cql) => {
        const db = new Set((await executeCql(w.ctx(), { cql }, { now: NOW, pageSize: 100 })).data.map((r) => r.id));
        const { where } = await predicateCql(w.ctx(), { cql }, { now: NOW });
        for (const row of board) {
          const got = matches(where, row);
          total++;
          if (got === UNDECIDED) continue;
          decided++;
          expect(got, `${cql} on ${row.title}`).toBe(db.has(row.id as string));
        }
      }),
      { numRuns: 200 },
    );
    // Most clauses are about the card itself.
    expect(decided / total).toBeGreaterThan(0.6);
  }, 300_000);
});
