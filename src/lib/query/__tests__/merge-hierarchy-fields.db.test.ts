// (e2e DB) Two orphaned halves of filterable pairs.
//
// `cancelReason = MERGED` could say THAT an item was merged and never WHICH
// item it was merged into, although `WorkItem.mergedIntoId` has been a plain
// column since COSMOS-207 and the UI names the survivor in four places
// ("Merge into…", "Merged into #12", the cancel note, and the "Open it" button).
// And `parent IS EMPTY` could ask for a root while "does this have sub-items at
// all" was inexpressible, because `parent` / `ancestor` / `childrenOf()` all
// need a NAMED parent.
//
// The registry's guards only prove a field id is HANDLED by the compiler. These
// specs prove each one filters, against a real database, and pin the one
// judgement call: an ARCHIVED sub-item does not count.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { executeCql } from "../execute.server";
import { seedWorld, type World } from "./cql-fixture";

const NOW = new Date("2026-10-15T15:00:00Z");

describe("CQL reaches the merge target and the sub-item count (e2e DB)", () => {
  let w: World;

  beforeAll(async () => {
    w = await seedWorld();
    // A merge, written the way merge.server.ts writes one: the duplicate stays,
    // Cancelled with reason MERGED, pointing at the survivor. `p1-login-bug` is
    // ticket 1 in P1, so its key is `<P1>-1`.
    await prisma.workItem.update({
      where: { id: w.items["p1-done"].id },
      data: {
        cancelReason: "MERGED",
        cancelNote: "Merged into it",
        mergedIntoId: w.items["p1-login-bug"].id,
      },
    });
    const mk = async (title: string, n: number, data: Record<string, unknown> = {}) =>
      (
        await prisma.workItem.create({
          data: {
            orgId: w.orgA,
            projectId: w.P1.id,
            ticketNumber: n,
            title,
            description: "",
            columnKey: "todo",
            workItemTypeId: w.typeTask,
            createdById: w.actor.id,
            ...data,
          },
          select: { id: true },
        })
      ).id;
    // Two parents, identical but for ONE thing: whether their only sub-item is
    // archived. That pairing is the control for the archived-child semantic —
    // a compiler that ignored archivedAt would put both in the same bucket.
    const liveParent = await mk("hc-parent-live", 91);
    const archParent = await mk("hc-parent-archivedkid", 92);
    await mk("hc-kid-live", 93, { parentId: liveParent });
    await mk("hc-kid-archived", 94, { parentId: archParent, archivedAt: new Date("2026-09-01T00:00:00Z") });
  }, 60_000);

  afterAll(async () => {
    await w?.cleanup();
  });

  /** Matching item titles (the fixture names restricted rows `<name>-<stamp>`). */
  const keys = async (cql: string) => {
    const r = await executeCql(w.ctx(), { cql }, { now: NOW, pageSize: 100 });
    return r.data.map((x) => String(x.title).replace(`-${w.stamp}`, "")).sort();
  };

  it("positive control: every seeded row is readable before anything is filtered", async () => {
    // So an empty result below means "filtered out", not "never visible".
    const all = await keys("");
    for (const t of ["p1-done", "p1-login-bug", "p1-child", "hc-parent-live", "hc-parent-archivedkid", "hc-kid-live"]) {
      expect(all, t).toContain(t);
    }
    // The archived CHILD is hidden by default, as archived work is everywhere.
    expect(all).not.toContain("hc-kid-archived");
    // And the fixture really carries the merge we wrote.
    const row = await prisma.workItem.findUniqueOrThrow({
      where: { id: w.items["p1-done"].id },
      select: { mergedIntoId: true, cancelReason: true },
    });
    expect(row).toEqual({ mergedIntoId: w.items["p1-login-bug"].id, cancelReason: "MERGED" });
  });

  it("mergedInto names the survivor, which cancelReason = MERGED cannot", async () => {
    expect(await keys(`mergedInto = ${w.P1.key}-1`)).toEqual(["p1-done"]);
    // The half of the pair that already existed says only THAT it was merged.
    expect(await keys("cancelReason = MERGED")).toEqual(["p1-done"]);
    // A different survivor matches nothing, so the filter reads the id rather
    // than "has been merged at all".
    expect(await keys(`mergedInto = ${w.P1.key}-3`)).toEqual([]);
  });

  it("mergedInto IS EMPTY is everything that was not merged away", async () => {
    const empty = await keys("mergedInto IS EMPTY");
    expect(empty).toContain("p1-login-bug");
    expect(empty).not.toContain("p1-done");
  });

  it("hasChildren = true finds the parent, = false finds the leaf", async () => {
    const parents = await keys("hasChildren = true");
    // p1-login-bug is p1-child's parent in the fixture.
    expect(parents).toContain("p1-login-bug");
    expect(parents).toContain("hc-parent-live");
    expect(parents).not.toContain("hc-kid-live");

    const leaves = await keys("hasChildren = false");
    expect(leaves).toContain("hc-kid-live");
    expect(leaves).toContain("p1-child");
    expect(leaves).not.toContain("p1-login-bug");
    expect(leaves).not.toContain("hc-parent-live");
  });

  it("an ARCHIVED sub-item does not count — the deliberate choice, pinned", async () => {
    // hc-parent-live and hc-parent-archivedkid differ in exactly one thing: the
    // child's archivedAt. Both have precisely one sub-item.
    const parents = await keys("hasChildren = true");
    expect(parents).toContain("hc-parent-live");
    expect(parents).not.toContain("hc-parent-archivedkid");
    expect(await keys("hasChildren = false")).toContain("hc-parent-archivedkid");
  });

  it("the words people would type reach the same fields", async () => {
    // Each pair is asserted NON-EMPTY first: two empty arrays are equal, so the
    // comparison alone would pass just as happily over an alias that resolved
    // to a custom field nobody has and matched nothing.
    const viaAlias = await keys("children = true");
    expect(viaAlias.length).toBeGreaterThan(0);
    expect(viaAlias).toEqual(await keys("hasChildren = true"));

    const mergedAlias = await keys(`merged = ${w.P1.key}-1`);
    expect(mergedAlias).toEqual(["p1-done"]);
    expect(mergedAlias).toEqual(await keys(`mergedInto = ${w.P1.key}-1`));
  });
});
