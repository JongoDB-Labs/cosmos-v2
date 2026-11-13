// @vitest-environment node
// (e2e DB) The assistant's saved-filter tools, against real Postgres and real
// role permissions (memberToolCtx), in a world of their own (cql-fixture):
//
//   actor  MEMBER, member of P1 and P3; NOT on team-scoped P2
//   bob    MEMBER, member of P1, on team "Platform" (P1)
//   ghost  MEMBER, member of P2 only, on P2's secret team
//   admin  ADMIN, made here
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { withCqlEnabled } from "@/lib/query/flag";
import { memberToolCtx, stubToolCtx } from "@/lib/testing/tool-auth";
import { seedWorld, type World } from "@/lib/query/__tests__/cql-fixture";
import type { ToolContext } from "./_ctx";
import { createSavedView, deleteSavedView, listSavedViews, shareSavedView, updateSavedView } from "./saved-views";
import { savedViewTools } from "../tools/saved-views";

type View = { id: string; name: string; visibility: string; projectId: string | null; teamId: string | null; ownerId: string; mine: boolean; url: string };
type Listed = { count: number; views: View[] };

describe("saved-view tools (e2e DB)", () => {
  let w: World;
  let actor: ToolContext;
  let bob: ToolContext;
  let ghost: ToolContext;
  let admin: ToolContext;
  let adminUserId: string;
  let slug: string;

  const ids = async (ctx: ToolContext, input: Record<string, unknown> = {}) => ((await listSavedViews(input, ctx)) as Listed).views.map((v) => v.id);
  // Cosmo saves a filter private; sharing it is share_saved_view's own step.
  const make = async (ctx: ToolContext, input: Record<string, unknown>) => {
    const { visibility, projectId, teamId, ...fields } = input;
    const r = (await createSavedView(fields, ctx)) as View & { created?: true; error?: string };
    expect(r.error, `create ${String(input.name)}`).toBeUndefined();
    if (visibility === undefined || visibility === "PRIVATE") return r;
    const s = (await shareSavedView({ viewId: r.id, visibility, projectId, teamId }, ctx)) as View & { error?: string };
    expect(s.error, `share ${String(input.name)}`).toBeUndefined();
    return { ...r, ...s };
  };
  const row = (id: string) => prisma.savedView.findUnique({ where: { id }, select: { name: true, visibility: true, cqlText: true, projectId: true } });

  beforeAll(async () => {
    w = await seedWorld();
    const org = await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object }, select: { slug: true } });
    slug = org.slug;
    const pm = await prisma.projectMember.findFirstOrThrow({ where: { projectId: w.P2.id }, select: { orgMember: { select: { userId: true } } } });
    const adminUser = await prisma.user.create({ data: { email: `sv-admin-${w.stamp}@test.local`, displayName: "Sam Admin" } });
    adminUserId = adminUser.id;
    await prisma.orgMember.create({ data: { orgId: w.orgA, userId: adminUserId, role: "ADMIN" } });
    [actor, bob, ghost, admin] = await Promise.all([
      memberToolCtx(w.orgA, w.actor.id),
      memberToolCtx(w.orgA, w.bob.id),
      memberToolCtx(w.orgA, pm.orgMember.userId),
      memberToolCtx(w.orgA, adminUserId),
    ]);
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
    if (adminUserId) await prisma.user.deleteMany({ where: { id: adminUserId } }).catch(() => undefined);
  });

  it("a member creates, lists, updates and deletes their own filter", async () => {
    const made = await make(actor, { name: "mine high", cql: "priority = HIGH" });
    expect(made).toMatchObject({ created: true, name: "mine high", visibility: "PRIVATE", ownerId: w.actor.id, mine: true, projectId: null });
    expect(made.url).toBe(`/${slug}/work-items?filter=${made.id}`);
    expect(await ids(actor)).toContain(made.id);

    const updated = await updateSavedView({ viewId: made.id, name: "mine low", cql: "priority = LOW" }, actor);
    expect(updated).toMatchObject({ updated: true, id: made.id, name: "mine low" });
    expect(await row(made.id)).toMatchObject({ name: "mine low", cqlText: "priority = LOW" });

    expect(await deleteSavedView({ viewId: made.id }, actor)).toEqual({ deleted: true, id: made.id, name: "mine low" });
    expect(await row(made.id)).toBeNull();
    expect(await ids(actor)).not.toContain(made.id);
  });

  it("Cosmo saves a filter private whatever visibility it asks for; sharing is share_saved_view's step", async () => {
    // Nothing on the tool invites it to ask.
    const create = savedViewTools.find((t) => t.name === "create_saved_view")!;
    expect(Object.keys(create.input_schema.properties ?? {})).toEqual(["name", "cql", "description"]);

    // An administrator, who may share with the whole organization, asks to on create.
    const asked = (await createSavedView({ name: "admin asks org", cql: "priority = HIGH", visibility: "ORG" }, admin)) as View & Record<string, unknown>;
    expect(asked).toMatchObject({ created: true, visibility: "PRIVATE", requestedVisibility: "ORG", nextStep: "share_saved_view" });
    expect(await row(asked.id)).toMatchObject({ visibility: "PRIVATE", projectId: null });
    expect(await ids(bob)).not.toContain(asked.id);
    // So does a member, for a project they can read.
    const onP1 = (await createSavedView({ name: "actor asks P1", cql: "priority = HIGH", visibility: "PROJECT", projectId: w.P1.id }, actor)) as View;
    expect(await row(onP1.id)).toMatchObject({ visibility: "PRIVATE", projectId: null });
    // A plain create says nothing about sharing.
    expect(await createSavedView({ name: "actor plain", cql: "priority = HIGH" }, actor)).not.toHaveProperty("requestedVisibility");

    // Positive control: the same administrator shares it with share_saved_view, and everyone sees it.
    expect(await shareSavedView({ viewId: asked.id, visibility: "ORG" }, admin)).toMatchObject({ shared: true, visibility: "ORG" });
    expect(await row(asked.id)).toMatchObject({ visibility: "ORG" });
    expect(await ids(bob)).toContain(asked.id);
  });

  it("a query the language rejects comes back with diagnostics, and nothing is saved", async () => {
    const res = (await createSavedView({ name: "bad sprint", cql: "sprint = Nosuchsprint" }, actor)) as { error: string; diagnostics: { line: number }[] };
    expect(res.error).toMatch(/Fix the query and try again\.$/);
    expect(res.diagnostics.length).toBeGreaterThan(0);
    expect(await prisma.savedView.count({ where: { orgId: w.orgA, name: "bad sprint" } })).toBe(0);
  });

  it("a member may not share with the whole org; an administrator may", async () => {
    const mine = await make(actor, { name: "to share", cql: "priority = HIGH" });

    // Refused by the API's own rule (FILTER_SHARE_ORG).
    expect(await shareSavedView({ viewId: mine.id, visibility: "ORG" }, actor)).toEqual({
      error: "Sharing a filter with the whole organization needs the Share filters with the org permission.",
    });
    expect((await row(mine.id))?.visibility).toBe("PRIVATE");
    // Asking on create doesn't get round it: the filter is saved private.
    expect(await createSavedView({ name: "org from start", cql: "priority = HIGH", visibility: "ORG" }, actor)).toMatchObject({ created: true, visibility: "PRIVATE" });
    expect(await prisma.savedView.findMany({ where: { orgId: w.orgA, name: "org from start" }, select: { visibility: true } })).toEqual([{ visibility: "PRIVATE" }]);
    // ...while sharing it more narrowly works, so the refusal is the permission, not the call.
    expect(await shareSavedView({ viewId: mine.id, visibility: "PROJECT", projectId: w.P1.id }, actor)).toMatchObject({ shared: true, visibility: "PROJECT", projectId: w.P1.id });

    // The same request from an administrator goes through, and is audited.
    expect(await shareSavedView({ viewId: mine.id, visibility: "ORG" }, admin)).toMatchObject({ shared: true, id: mine.id, visibility: "ORG" });
    expect((await row(mine.id))?.visibility).toBe("ORG");
    expect(await prisma.auditLog.count({ where: { orgId: w.orgA, action: "saved_filter.shared_org", entityId: mine.id } })).toBe(1);
    const own = await make(admin, { name: "admin org", cql: "priority = HIGH", visibility: "ORG" });
    expect(own.visibility).toBe("ORG");
    expect(await ids(bob)).toEqual(expect.arrayContaining([mine.id, own.id]));
  });

  it("someone who neither owns nor co-edits a filter can't change or delete it", async () => {
    const shared = await make(actor, { name: "actor P1", cql: "priority = HIGH", visibility: "PROJECT", projectId: w.P1.id });
    const hidden = await make(actor, { name: "actor private", cql: "priority = HIGH" });
    // Bob sees the shared one, so what refuses him below is the edit rule, not visibility.
    expect(await ids(bob)).toContain(shared.id);
    expect(await ids(bob)).not.toContain(hidden.id);

    expect(await updateSavedView({ viewId: shared.id, name: "bob was here" }, bob)).toEqual({ error: "Only the owner, its editors or an administrator can change this filter." });
    expect(await shareSavedView({ viewId: shared.id, visibility: "PRIVATE" }, bob)).toEqual({ error: "Only the owner, its editors or an administrator can change this filter." });
    expect(await deleteSavedView({ viewId: shared.id }, bob)).toEqual({ error: "Only the owner or an administrator can delete this filter." });
    // One he can't see reads as absent, whatever he asks.
    expect(await updateSavedView({ viewId: hidden.id, name: "bob was here" }, bob)).toEqual({ error: "Not found" });
    expect(await deleteSavedView({ viewId: hidden.id }, bob)).toEqual({ error: "Not found" });
    expect(await row(shared.id)).toMatchObject({ name: "actor P1", visibility: "PROJECT" });
    expect(await row(hidden.id)).toMatchObject({ name: "actor private" });

    // A co-editor may rename it, and still may neither re-share nor delete it.
    await prisma.savedViewEditor.create({ data: { savedViewId: shared.id, userId: w.bob.id } });
    expect(await updateSavedView({ viewId: shared.id, name: "bob renamed" }, bob)).toMatchObject({ updated: true, name: "bob renamed" });
    expect(await shareSavedView({ viewId: shared.id, visibility: "PRIVATE" }, bob)).toEqual({ error: "Only the owner or an administrator can change who sees or edits this filter." });
    expect(await deleteSavedView({ viewId: shared.id }, bob)).toEqual({ error: "Only the owner or an administrator can delete this filter." });
    expect(await row(shared.id)).toMatchObject({ name: "bob renamed", visibility: "PROJECT" });
  });

  it("a filter shared with a team-scoped project the caller can't read is not listed", async () => {
    const onP2 = await make(ghost, { name: "ghost P2", cql: "priority = HIGH", visibility: "PROJECT", projectId: w.P2.id });
    const onTeam = await make(ghost, { name: "ghost team", cql: "priority = HIGH", visibility: "TEAM", teamId: w.teamP2 });
    const onP1 = await make(bob, { name: "bob P1 for all", cql: "priority = HIGH", visibility: "PROJECT", projectId: w.P1.id });
    // Positive controls: the rows exist and their own audience sees them.
    expect(await ids(ghost)).toEqual(expect.arrayContaining([onP2.id, onTeam.id]));
    expect(await ids(actor)).toContain(onP1.id);

    const seen = await ids(actor);
    expect(seen).not.toContain(onP2.id);
    expect(seen).not.toContain(onTeam.id);
    // Naming the project doesn't get round it, for a list or a write.
    expect(await listSavedViews({ projectId: w.P2.id }, actor)).toEqual({ error: "Project not found" });
    const intoP2 = await make(actor, { name: "into P2", cql: "priority = HIGH" });
    expect(await shareSavedView({ viewId: intoP2.id, visibility: "PROJECT", projectId: w.P2.id }, actor)).toEqual({ error: "Project not found" });
    expect(await shareSavedView({ viewId: onP2.id, visibility: "PRIVATE" }, actor)).toEqual({ error: "Not found" });
    expect(await row(intoP2.id)).toMatchObject({ visibility: "PRIVATE", projectId: null });
    // ...while the project filter it can read narrows as asked.
    expect(await ids(actor, { projectId: w.P1.id })).toContain(onP1.id);
  });

  it("an API key's project scope narrows what the tools see", async () => {
    const onP1 = await make(bob, { name: "bob P1 scoped", cql: "priority = HIGH", visibility: "PROJECT", projectId: w.P1.id });
    const scoped: ToolContext = { ...actor, auth: { ...actor.auth, projectScope: [w.P3.id] } };
    // Positive control: unscoped, the actor sees it.
    expect(await ids(actor)).toContain(onP1.id);

    expect(await ids(scoped)).not.toContain(onP1.id);
    expect(await listSavedViews({ projectId: w.P1.id }, scoped)).toEqual({ error: "Project not found" });
    const intoP1 = await make(actor, { name: "scoped into P1", cql: "priority = HIGH" });
    expect(await shareSavedView({ viewId: intoP1.id, visibility: "PROJECT", projectId: w.P1.id }, scoped)).toEqual({ error: "Project not found" });
    expect(await row(intoP1.id)).toMatchObject({ visibility: "PRIVATE", projectId: null });
  });

  it("a caller with no membership gets nothing from any of them", async () => {
    const nobody = await memberToolCtx(w.orgA, "00000000-0000-0000-0000-000000000000");
    const some = await make(actor, { name: "for nobody", cql: "priority = HIGH" });
    const denied = { error: "Insufficient permissions" };
    expect(await listSavedViews({}, nobody)).toEqual(denied);
    expect(await createSavedView({ name: "nobody's", cql: "priority = HIGH" }, nobody)).toEqual(denied);
    expect(await updateSavedView({ viewId: some.id, name: "x" }, nobody)).toEqual(denied);
    expect(await shareSavedView({ viewId: some.id, visibility: "ORG" }, nobody)).toEqual(denied);
    expect(await deleteSavedView({ viewId: some.id }, nobody)).toEqual(denied);
    expect(await row(some.id)).toMatchObject({ name: "for nobody", visibility: "PRIVATE" });
  });

  it("a member holding no permissions is refused before their input is read", async () => {
    // The differential the tool-auth arch test runs: with an empty input, the
    // permission check must answer, not the input check after it.
    const powerless = stubToolCtx(w.orgA, w.actor.id);
    for (const tool of [listSavedViews, createSavedView, updateSavedView, shareSavedView, deleteSavedView]) {
      expect(await tool({}, powerless), tool.name).toEqual({ error: "Insufficient permissions" });
    }
    // Positive control: with ITEM_READ the same empty input reaches the input check.
    expect(await deleteSavedView({}, actor)).toMatchObject({ error: expect.stringMatching(/^Invalid input/) });
  });
});
