// (e2e DB) `mentions`: the items where someone is @mentioned, in the item's
// description or in a comment. `mentions = me` was refused outright ("Unknown
// field") although the editor's own help suggested it.
//
// A mention is a token in the text (`<@id>`, or the typed `<@user:id>` the
// parser also reads). Comments are matched only where the actor may read them:
// the comment thread's own gate (COMMENT_READ, per project) and the fragment
// every comment read applies (public, not deleted, not hidden). `comments.some`
// is a nested filter the scope envelope does not reach, so without that a
// query could say "you are mentioned here" from an internal comment the actor
// can't open.
//
// Every absence below is paired with a positive control in the same spec, so a
// query that matched nothing could not pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { executeCql } from "../execute.server";
import { seedWorld, type World } from "./cql-fixture";

const NOW = new Date("2026-10-15T15:00:00Z");

describe("CQL: mentions (e2e DB)", () => {
  let w: World;

  beforeAll(async () => {
    w = await seedWorld();
    let n = 600;
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
    const me = w.actor.id;

    await item("m-description", `Can you look, <@${me}>?`);
    await comment(await item("m-comment"), `<@${me}> this one is yours`);
    await comment(await item("m-typed-token"), `see <@user:${me}>`);
    await comment(await item("m-other-person"), `<@${w.bob.id}> please`);
    await comment(await item("m-internal-comment"), `<@${me}> staff only`, { visibility: "INTERNAL" });
    await comment(await item("m-deleted-comment"), `<@${me}> gone`, { deletedAt: new Date("2026-10-01T00:00:00Z") });
    await comment(await item("m-hidden-comment"), `<@${me}> hidden`, { hiddenAt: new Date("2026-10-01T00:00:00Z") });
    await item("m-plain-text", `my id written out, ${me}, is not a mention`);
    // A restricted project: the envelope keeps it out whatever matches.
    await item(`m-restricted-${w.stamp}`, `<@${me}>`, w.P2.id);
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
    return r.data.map((x) => String(x.title)).filter((t) => t.startsWith("m-")).sort();
  };

  it("`mentions = me` finds a mention in the description and in a readable comment, in either token form", async () => {
    expect(await titles(reader(), "mentions = me")).toEqual(["m-comment", "m-description", "m-typed-token"]);
  });

  it("a person, by name, and a list", async () => {
    expect(await titles(reader(), 'mentions = "Bob Builder"')).toEqual(["m-other-person"]);
    expect(await titles(reader(), 'mentions IN (me, "Bob Builder")')).toEqual(["m-comment", "m-description", "m-other-person", "m-typed-token"]);
  });

  it("never matches through an internal, deleted or hidden comment", async () => {
    const got = await titles(reader(), "mentions = me");
    expect(got).toContain("m-comment"); // the positive control
    for (const t of ["m-internal-comment", "m-deleted-comment", "m-hidden-comment"]) expect(got).not.toContain(t);
  });

  it("without COMMENT_READ only the description counts", async () => {
    // Same actor, same rows, minus the comment permission.
    expect(await titles(w.ctx(), "mentions = me")).toEqual(["m-description"]);
  });

  it("a bare id in prose is not a mention, and a restricted project stays out", async () => {
    const got = await titles(reader(), "mentions = me");
    expect(got).toContain("m-description");
    expect(got).not.toContain("m-plain-text");
    expect(got.some((t) => t.startsWith("m-restricted"))).toBe(false);
  });

  it("`!=` is the complement within what the actor can read", async () => {
    const got = await titles(reader(), "mentions != me");
    expect(got).toContain("m-other-person");
    expect(got).toContain("m-internal-comment");
    for (const t of ["m-comment", "m-description", "m-typed-token"]) expect(got).not.toContain(t);
  });
});
