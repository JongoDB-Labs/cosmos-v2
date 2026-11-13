// (e2e DB) `comment ~` and `text ~` match only comments the actor can read.
//
// A comment search is a nested filter (`comments.some`) that the scope
// envelope does not reach: the envelope decides which ITEMS the actor may see,
// not which of an item's comments. Unscoped, a readable item matched through an
// internal, deleted, hidden or over-ceiling comment the actor can't open.
//
// The scope is the comment thread's own: COMMENT_READ per project, then public,
// not deleted, not hidden, and marked within the org's ceiling (the fixture org
// is not a gov tenant, so its ceiling is UNCLASSIFIED and a CUI marking is over
// it). It is the same scope `mentions` uses.
//
// Every absence is paired with a positive control in the same spec, so a query
// that matched nothing could not pass.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { executeCql } from "../execute.server";
import { seedWorld, type World } from "./cql-fixture";

const NOW = new Date("2026-10-15T15:00:00Z");

describe("CQL: comment text search reads only readable comments (e2e DB)", () => {
  let w: World;
  /** A word that appears in comments only, never in a title or description. */
  let word: string;
  /** A second such word, in one public comment on a P1 item and one on a P3 item. */
  let perProject: string;

  beforeAll(async () => {
    w = await seedWorld();
    word = `quokka${w.stamp}`;
    let n = 700;
    const item = async (title: string, description = "", projectId = w.P1.id) =>
      (
        await prisma.workItem.create({
          data: {
            orgId: w.orgA, projectId, ticketNumber: n++, title, description, columnKey: "todo",
            workItemTypeId: w.typeTask, createdById: w.bob.id,
          },
          select: { id: true },
        })
      ).id;
    const comment = (workItemId: string, content: string, extra: Record<string, unknown> = {}) =>
      prisma.comment.create({ data: { orgId: w.orgA, workItemId, authorId: w.bob.id, content, ...extra } });
    const earlier = new Date("2026-10-01T00:00:00Z");

    await comment(await item("c-visible"), `the ${word} is here`);
    await comment(await item("c-marked-within-ceiling"), `the ${word} is here`, { classification: "UNCLASSIFIED" });
    await comment(await item("c-internal"), `the ${word} is here`, { visibility: "INTERNAL" });
    await comment(await item("c-deleted"), `the ${word} is here`, { deletedAt: earlier });
    await comment(await item("c-hidden"), `the ${word} is here`, { hiddenAt: earlier });
    await comment(await item("c-over-ceiling"), `the ${word} is here`, { classification: "CUI" });
    // An item whose only matching comment is hidden, next to a visible comment
    // that doesn't match: the visible one must not carry the hidden one in.
    const mixed = await item("c-hidden-beside-a-visible-one");
    await comment(mixed, "nothing to see");
    await comment(mixed, `the ${word} is here`, { hiddenAt: earlier });
    await item("c-in-description", `the ${word} is in the description`);
    await item("c-no-match", "unrelated");

    // The same public comment, mentioning the actor, in two readable projects.
    perProject = `wombat${w.stamp}`;
    const me = w.actor.id;
    await comment(await item("c-p1-public"), `the ${perProject} is here, <@${me}>`);
    await comment(await item("c-p3-public", "", w.P3.id), `the ${perProject} is here, <@${me}>`);
  }, 60_000);

  afterAll(async () => {
    await w?.cleanup();
  });

  /** A member who may read comments. The fixture's context carries ITEM_READ alone. */
  const reader = (): AuthContext => {
    const base = w.ctx();
    const permissions = base.permissions | Permission.COMMENT_READ;
    return { ...base, permissions, basePermissions: permissions };
  };

  const titles = async (ctx: AuthContext, cql: string) => {
    const r = await executeCql(ctx, { cql }, { now: NOW, pageSize: 100 });
    return r.data.map((x) => String(x.title)).filter((t) => t.startsWith("c-")).sort();
  };

  /** The same reader, with an ABAC deny on COMMENT_READ in P3 alone. Items in P3 stay readable. */
  const noCommentsInP3 = (): AuthContext => ({
    ...reader(),
    abacRules: [{ effect: "deny", actions: ["COMMENT_READ"], conditions: [{ attr: "projectId", op: "eq", value: w.P3.id }] }],
  });

  const UNREADABLE = ["c-internal", "c-deleted", "c-hidden", "c-over-ceiling", "c-hidden-beside-a-visible-one"];

  it("`comment ~` matches a visible comment, and nothing internal, deleted, hidden or over the ceiling", async () => {
    const got = await titles(reader(), `comment ~ "${word}"`);
    expect(got).toEqual(["c-marked-within-ceiling", "c-visible"]);
    for (const t of UNREADABLE) expect(got).not.toContain(t);
  });

  it("`text ~` matches the description and visible comments only", async () => {
    const got = await titles(reader(), `text ~ "${word}"`);
    expect(got).toEqual(["c-in-description", "c-marked-within-ceiling", "c-visible"]);
    for (const t of UNREADABLE) expect(got).not.toContain(t);
  });

  it("plain words search like `text ~`", async () => {
    expect(await titles(reader(), word)).toEqual(["c-in-description", "c-marked-within-ceiling", "c-visible"]);
  });

  it("without COMMENT_READ no comment counts, but the description still does", async () => {
    // Same actor, same rows, minus the comment permission.
    expect(await titles(w.ctx(), `comment ~ "${word}"`)).toEqual([]);
    expect(await titles(w.ctx(), `text ~ "${word}"`)).toEqual(["c-in-description"]);
  });

  it("the negation is the complement within what the actor can read", async () => {
    const got = await titles(reader(), `NOT comment ~ "${word}"`);
    for (const t of UNREADABLE) expect(got).toContain(t);
    expect(got).toContain("c-no-match");
    for (const t of ["c-visible", "c-marked-within-ceiling"]) expect(got).not.toContain(t);
  });

  describe("COMMENT_READ is decided per project", () => {
    it("the control: with COMMENT_READ in both projects, both public comments match", async () => {
      // So the P3 absence below is the policy, not an unreadable item or a missing comment.
      expect(await titles(reader(), `comment ~ "${perProject}"`)).toEqual(["c-p1-public", "c-p3-public"]);
      expect(await titles(reader(), "mentions = me")).toEqual(["c-p1-public", "c-p3-public"]);
    });

    it("denied COMMENT_READ in P3: `comment ~`, `text ~` and `mentions` match only the P1 comment", async () => {
      const ctx = noCommentsInP3();
      expect(await titles(ctx, `comment ~ "${perProject}"`)).toEqual(["c-p1-public"]);
      expect(await titles(ctx, `text ~ "${perProject}"`)).toEqual(["c-p1-public"]);
      expect(await titles(ctx, perProject)).toEqual(["c-p1-public"]);
      expect(await titles(ctx, "mentions = me")).toEqual(["c-p1-public"]);
    });

    it("denied COMMENT_READ in P3: the P3 item is readable, and `NOT comment ~` keeps it", async () => {
      const ctx = noCommentsInP3();
      const got = await titles(ctx, `NOT comment ~ "${perProject}"`);
      expect(got).toContain("c-p3-public");
      expect(got).not.toContain("c-p1-public");
    });
  });

  describe("the comment scope's cost does not grow with the project count", () => {
    beforeAll(async () => {
      // More readable projects, so a per-project lookup would show as a count.
      for (let i = 0; i < 6; i++) {
        await prisma.project.create({ data: { orgId: w.orgA, name: `Extra ${i}`, key: `XTR${i}` } });
      }
    });

    /** Reads of the project and membership tables while one query runs. */
    const lookups = async (ctx: AuthContext, cql: string) => {
      const delegates = { project: prisma.project, projectMember: prisma.projectMember, orgMember: prisma.orgMember } as unknown as Record<
        string,
        Record<string, (...args: unknown[]) => unknown>
      >;
      const reads = ["findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "findMany", "count"];
      const spies = Object.values(delegates).flatMap((d) => reads.map((op) => vi.spyOn(d, op)));
      try {
        await executeCql(ctx, { cql }, { now: NOW, pageSize: 100 });
        return spies.reduce((n, s) => n + s.mock.calls.length, 0);
      } finally {
        for (const s of spies) s.mockRestore();
      }
    };

    it("a comment search reads no more projects than the same search on titles", async () => {
      const ctx = reader();
      const readable = await prisma.project.count({ where: { orgId: w.orgA, teamScopedAccess: false } });
      expect(readable).toBeGreaterThanOrEqual(8);
      const titlesOnly = await lookups(ctx, `title ~ "${perProject}"`);
      // The control: the spies see the readable-project lookup every query makes.
      expect(titlesOnly).toBeGreaterThan(0);
      expect(await lookups(ctx, `text ~ "${perProject}"`)).toBe(titlesOnly);
      expect(await lookups(ctx, `comment ~ "${perProject}"`)).toBe(titlesOnly);
      // And the scope it builds is still the per-project one.
      expect(await titles(noCommentsInP3(), `text ~ "${perProject}"`)).toEqual(["c-p1-public"]);
    });
  });
});
