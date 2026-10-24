// (e2e DB) WAS / CHANGED over Activity (query design §3.6).
//
// Each item gets a hand-written timeline: dated Activity rows, as the
// work-item writers record them, plus its current columns. The expectations
// below are read off those timelines, not computed by the code under test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { executeCql } from "../execute.server";
import { seedWorld, type World } from "./cql-fixture";

const NOW = new Date("2026-10-15T15:00:00Z");
const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe("CQL history (e2e DB)", () => {
  let w: World;
  let bob: string;
  beforeAll(async () => {
    w = await seedWorld();
    bob = w.bob.id;
    const A = w.orgA;
    let n = 200;
    const item = async (title: string, projectId: string, created: string, data: Record<string, unknown> = {}) =>
      (
        await prisma.workItem.create({
          data: {
            orgId: A, projectId, ticketNumber: n++, title, description: "", columnKey: "todo",
            workItemTypeId: w.typeTask, createdById: w.actor.id, createdAt: d(created), ...data,
          },
        })
      ).id;
    const change = (workItemId: string, at: string, field: string, oldValue: string | null, newValue: string | null, userId = w.actor.id) =>
      prisma.activity.create({ data: { orgId: A, workItemId, userId, action: "updated", field, oldValue, newValue, createdAt: d(at) } });

    // hx-regressed: todo → in-progress (09-05) → done (09-20, bob) → in-progress (10-05, bob).
    // Due: none → 10-20 (09-10) → 10-25 (10-01).
    const regressed = await item("hx-regressed", w.P1.id, "2026-09-01", { columnKey: "in-progress", dueDate: new Date("2026-10-25T00:00:00Z") });
    await change(regressed, "2026-09-05", "columnKey", "todo", "in-progress");
    await change(regressed, "2026-09-20", "columnKey", "in-progress", "done", bob);
    await change(regressed, "2026-10-05", "columnKey", "done", "in-progress", bob);
    await change(regressed, "2026-09-10", "dueDate", null, "2026-10-20T00:00:00.000Z");
    await change(regressed, "2026-10-01", "dueDate", "2026-10-20T00:00:00.000Z", "2026-10-25T00:00:00.000Z");

    // hx-steady: done since creation, nothing recorded.
    await item("hx-steady", w.P1.id, "2026-09-01", { columnKey: "done" });

    // hx-quick: created 10-10, todo → review and unassigned → bob on 10-11.
    const quick = await item("hx-quick", w.P1.id, "2026-10-10", { columnKey: "review", assigneeId: bob });
    await change(quick, "2026-10-11", "columnKey", "todo", "review");
    await change(quick, "2026-10-11", "assigneeId", null, bob);

    // hx-unlogged: todo → in-progress recorded (09-02); the move to done was not.
    const unlogged = await item("hx-unlogged", w.P1.id, "2026-09-01", { columnKey: "done" });
    await change(unlogged, "2026-09-02", "columnKey", "todo", "in-progress");

    // A restricted twin with the same history.
    const secret = await item(`hx-secret ${w.stamp}`, w.P2.id, "2026-09-01", { columnKey: "in-progress" });
    await change(secret, "2026-09-20", "columnKey", "in-progress", "done", bob);
    await change(secret, "2026-10-05", "columnKey", "done", "in-progress", bob);
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const titles = async (cql: string, ctx = w.ctx()) =>
    (await executeCql(ctx, { cql: `text ~ "hx-" AND (${cql})` }, { now: NOW, pageSize: 100 })).data.map((r) => r.title).sort();

  it("WAS: is it now, or did a recorded change leave or enter it", async () => {
    expect(await titles("status WAS Done")).toEqual(["hx-regressed", "hx-steady", "hx-unlogged"]);
    expect(await titles("status WAS NOT Done")).toEqual(["hx-quick"]);
    expect(await titles("status WAS IN (Done, Review)")).toEqual(["hx-quick", "hx-regressed", "hx-steady", "hx-unlogged"]);
  });

  it("WAS with a window: held the value at some instant in it", async () => {
    // hx-regressed left Done on 10-05; the others hold it still.
    expect(await titles("status WAS Done AFTER 2026-10-06")).toEqual(["hx-steady", "hx-unlogged"]);
    // hx-regressed reached Done only on 09-20.
    expect(await titles("status WAS Done BEFORE 2026-09-15")).toEqual(["hx-steady", "hx-unlogged"]);
    expect(await titles("status WAS Done DURING (2026-09-21, 2026-09-22)")).toEqual(["hx-regressed", "hx-steady", "hx-unlogged"]);
    // An unrecorded move is taken to have happened at the last recorded one.
    expect(await titles('status WAS "In Progress" ON 2026-09-10')).toEqual(["hx-regressed"]);
    // Entered Done inside the window (09-20), held something else when it opened.
    expect(await titles("status WAS Done DURING (2026-09-15, 2026-09-25)")).toEqual(["hx-regressed", "hx-steady", "hx-unlogged"]);
    // In Progress now, but only since 10-05: not during a window that closed before.
    expect(await titles('status WAS "In Progress" DURING (2026-09-25, 2026-10-01)')).toEqual([]);
    // Nothing is held before the item existed.
    expect(await titles("status WAS Review BEFORE 2026-10-01")).toEqual([]);
    // BEFORE alone: entered it, then left it, all before the end (hx-regressed
    // is In Progress again now, but changed since, so only that counts).
    expect(await titles('status WAS "In Progress" BEFORE 2026-09-15')).toEqual(["hx-regressed", "hx-unlogged"]);
    // BEFORE alone: nothing recorded before the end, and the first change
    // after it started from the value (hx-regressed, 09-05), or a change
    // before the end left it (hx-unlogged, 09-02).
    expect(await titles("status WAS Todo BEFORE 2026-09-04")).toEqual(["hx-regressed", "hx-unlogged"]);
    // Relative dates: 14 days before NOW is 10-01.
    expect(await titles("status WAS Done AFTER -14d")).toEqual(["hx-regressed", "hx-steady", "hx-unlogged"]);
  });

  it("CHANGED, with FROM / TO / BY / a window", async () => {
    expect(await titles("status CHANGED")).toEqual(["hx-quick", "hx-regressed", "hx-unlogged"]);
    expect(await titles('status CHANGED FROM Done TO "In Progress"')).toEqual(["hx-regressed"]);
    expect(await titles('status CHANGED FROM Done TO "In Progress" AFTER -14d')).toEqual(["hx-regressed"]);
    expect(await titles('status CHANGED FROM Done TO "In Progress" AFTER -5d')).toEqual([]);
    expect(await titles('status CHANGED BY "Bob Builder"')).toEqual(["hx-regressed"]);
    expect(await titles("status CHANGED TO (Review, Done)")).toEqual(["hx-quick", "hx-regressed"]);
    expect(await titles("status WAS Done AND NOT status CHANGED")).toEqual(["hx-steady"]);
  });

  it("WAS … BY: that person changed it to the value", async () => {
    expect(await titles('status WAS Done BY "Bob Builder"')).toEqual(["hx-regressed"]);
    expect(await titles("status WAS Done BY me")).toEqual([]);
  });

  it("assignee history is the primary assignee, EMPTY included", async () => {
    expect(await titles('assignee WAS "Bob Builder"')).toEqual(["hx-quick"]);
    expect(await titles("assignee WAS EMPTY")).toEqual(["hx-quick", "hx-regressed", "hx-steady", "hx-unlogged"]);
    expect(await titles('assignee CHANGED FROM EMPTY TO "Bob Builder"')).toEqual(["hx-quick"]);
    expect(await titles("assignee WAS EMPTY AFTER 2026-10-12")).toEqual(["hx-regressed", "hx-steady", "hx-unlogged"]);
  });

  it("dates compare as days, in and out of a window", async () => {
    expect(await titles("due WAS 2026-10-20")).toEqual(["hx-regressed"]);
    expect(await titles("due WAS 2026-10-20 AFTER 2026-10-02")).toEqual([]);
    expect(await titles("due CHANGED TO 2026-10-25")).toEqual(["hx-regressed"]);
    expect(await titles("due CHANGED FROM 2026-10-20 AFTER 2026-09-30")).toEqual(["hx-regressed"]);
    expect(await titles("due CHANGED FROM EMPTY")).toEqual(["hx-regressed"]);
    expect(await titles("due WAS EMPTY BEFORE 2026-09-05")).toEqual(["hx-regressed", "hx-steady", "hx-unlogged"]);
  });

  it("never reaches a restricted project; someone who reads it sees the same history", async () => {
    expect(await titles("status CHANGED BY \"Bob Builder\" OR status WAS Done DURING (2026-09-21, 2026-09-22)")).not.toContain(`hx-secret ${w.stamp}`);
    const admin = w.ctx({ role: OrgRole.ADMIN });
    expect(await titles('status CHANGED FROM Done TO "In Progress"', admin)).toEqual(["hx-regressed", `hx-secret ${w.stamp}`].sort());
    expect(await titles("status WAS Done DURING (2026-09-21, 2026-09-22)", admin)).toContain(`hx-secret ${w.stamp}`);
  });
});
