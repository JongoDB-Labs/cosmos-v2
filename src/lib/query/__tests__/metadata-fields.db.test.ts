// (e2e DB) FR 5409a485 — ticket metadata that the row carried and CQL could not
// name.
//
// Three columns existed on `WorkItem` with no field in the registry:
// `externalId` (the source system's own identifier — its sibling `externalKey`
// WAS filterable), `sourceStatus` (the raw upstream status, kept unmapped on
// import precisely so it can be inspected) and `cancelNote` (the reason text a
// cancellation carries, while `cancelReason` was filterable).
//
// The registry's arch test only proves a field id is HANDLED by the compiler.
// These specs prove each one actually filters, against a real database — the
// difference between wired and working.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { executeCql, predicateCql } from "../execute.server";
import { UNDECIDED, matches } from "../evaluate";
import { seedWorld, type World } from "./cql-fixture";

const NOW = new Date("2026-10-15T15:00:00Z");

describe("CQL reaches imported + cancellation metadata (e2e DB)", () => {
  let w: World;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    w = await seedWorld();
    // UPDATE the fixture's own items rather than minting rows. The fixture
    // creates items through `createWorkItemRow`, which fills in more than a raw
    // `prisma.create` does — my first attempt at a bare create failed Prisma
    // validation in beforeAll and silently SKIPPED all six specs.
    const set = async (key: string, data: Record<string, unknown>) => {
      const row = w.items[key];
      await prisma.workItem.update({ where: { id: row.id }, data });
      ids[key] = row.id;
    };
    // `p1-child` already carries cancelReason OBE in the fixture; it is the
    // natural home for the note.
    await set("p1-child", { cancelNote: "Programme restructured" });
    await set("p1-done", { externalSource: "jira", externalKey: "ACME-1", externalId: "10042", sourceStatus: "In Review" });
    await set("p1-coowned", { externalKey: "ACME_2" });
  });

  /** Matching item KEYS (the fixture names rows `<key>-<stamp>`). */
  const keys = async (cql: string) => {
    const r = await executeCql(w.ctx(), { cql }, { now: NOW, pageSize: 100 });
    return r.data
      .map((x) => String(x.title).replace(`-${w.stamp}`, ""))
      .sort();
  };

  it("externalId filters, and is NOT the same field as externalKey", async () => {
    expect(await keys('externalId = "10042"')).toContain("p1-done");
    // The gap in one assertion: the id and the key are different values, and
    // only the key could be named before.
    expect(await keys('externalKey = "10042"')).not.toContain("p1-done");
    expect(await keys('externalKey = "ACME-1"')).toContain("p1-done");
  });

  it("sourceStatus filters on the raw upstream text", async () => {
    // `status` is the MAPPED Cosmos column; this is what the source called it,
    // which is why both have to be reachable.
    expect(await keys('sourceStatus = "In Review"')).toContain("p1-done");
    expect(await keys('sourceStatus ~ "review"')).toContain("p1-done");
  });

  it("cancelNote filters, alongside the reason that was already filterable", async () => {
    expect(await keys('cancelNote ~ "restructured"')).toEqual(["p1-child"]);
    expect(await keys("cancelReason = OBE")).toContain("p1-child");
  });

  it("= on a text field matches the exact value, ignoring case, and the board's interpreter agrees", async () => {
    expect(await keys('externalKey = "ACME_1"')).toEqual([]);
    expect(await keys('externalKey = "acme_2"')).toEqual(["p1-coowned"]);
    expect(await keys('externalKey = "acme-1"')).toEqual(["p1-done"]);
    const rows = JSON.parse(JSON.stringify(await prisma.workItem.findMany({ where: { id: { in: [ids["p1-done"], ids["p1-coowned"]] } } })));
    expect(rows).toHaveLength(2);
    for (const cql of ['externalKey = "ACME_1"', 'externalKey = "acme_2"', 'externalKey = "acme-1"']) {
      const { where } = await predicateCql(w.ctx(), { cql }, { now: NOW });
      const db = new Set((await executeCql(w.ctx(), { cql }, { now: NOW, pageSize: 100 })).data.map((x) => x.id));
      for (const row of rows) {
        const got = matches(where, row);
        expect(got, `${cql} on ${row.title}`).not.toBe(UNDECIDED);
        expect(got, `${cql} on ${row.title}`).toBe(db.has(row.id));
      }
    }
  });

  it("IS EMPTY distinguishes an unset column from a set one", async () => {
    const empty = await keys("externalId IS EMPTY");
    expect(empty).toContain("p1-coowned");
    expect(empty).not.toContain("p1-done");
  });

  it("negative control: a value nothing carries matches nothing", async () => {
    // Otherwise a compiler that ignored the field would pass every spec above
    // by returning the whole project.
    expect(await keys('externalId = "nosuchthing"')).toEqual([]);
    expect(await keys('sourceStatus = "nosuchthing"')).toEqual([]);
    expect(await keys('cancelNote ~ "nosuchthing"')).toEqual([]);
  });

  it("positive control: the seeded rows ARE visible to this actor", async () => {
    // So the empty results above mean "filtered out", not "never readable".
    const all = await keys("");
    for (const k of ["p1-done", "p1-child", "p1-coowned"]) expect(all).toContain(k);
  });
});
