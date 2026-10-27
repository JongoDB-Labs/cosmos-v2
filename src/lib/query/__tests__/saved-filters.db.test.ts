// @vitest-environment node
// (e2e DB) Saved filters v2 (query design §10), with only the session mocked:
// real Postgres, real scoping, the real routes.
//
//   actor  member of P1 and P3; NOT on team-scoped P2
//   bob    member of P1, on team "Platform" (P1)
//   ghost  member of P2 only, on P2's secret team
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { withCqlEnabled } from "../flag";
import { RESTRICTED } from "../saved-filters.server";
import { seedWorld, type World } from "./cql-fixture";

const { getAuthContext, limiter } = vi.hoisted(() => ({ getAuthContext: vi.fn(), limiter: { on: false } }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rate-limit/guard", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/rate-limit/guard");
  return { ...real, checkRateLimit: (...a: Parameters<typeof real.checkRateLimit>) => (limiter.on ? real.checkRateLimit(...a) : null) };
});

import { GET as list, POST as create } from "@/app/api/v1/orgs/[orgId]/saved-views/route";
import { GET as getOne, PATCH as patch, PUT as legacyPut, DELETE as remove } from "@/app/api/v1/orgs/[orgId]/saved-views/[viewId]/route";
import { PUT as star, DELETE as unstar } from "@/app/api/v1/orgs/[orgId]/saved-views/[viewId]/favorite/route";
import { GET as search } from "@/app/api/v1/orgs/[orgId]/work-items/search/route";

describe("saved filters v2 (e2e DB)", () => {
  let w: World;
  let ghost: string;
  const as = (who: () => AuthContext) => getAuthContext.mockImplementation(async () => who());
  const user = (userId: string, extra: bigint = 0n, role: OrgRole = OrgRole.MEMBER): AuthContext => {
    const permissions = Permission.ITEM_READ | extra;
    return { userId, orgId: w.orgA, orgRole: role, permissions, basePermissions: permissions, abacRules: [] } as AuthContext;
  };
  const actor = (extra: bigint = 0n) => ({ ...w.ctx(), permissions: w.ctx().permissions | extra }) as AuthContext;
  const bob = () => user(w.bob.id);
  const params = () => Promise.resolve({ orgId: w.orgA });
  const vparams = (viewId: string) => Promise.resolve({ orgId: w.orgA, viewId });
  const req = (path: string, method = "GET", body?: unknown) =>
    new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    });
  const names = async () => ((await (await list(req("saved-views"), { params: params() })).json()) as { name: string }[]).map((v) => v.name).sort();

  /** A filter written straight to the table, as any owner could have saved it. */
  const seed = async (ownerId: string, name: string, query: unknown, extra: Record<string, unknown> = {}) =>
    (await prisma.savedView.create({ data: { orgId: w.orgA, ownerId, name, query: query as object, ...extra }, select: { id: true } })).id;
  const ref = (entity: string, id: string) => ({ t: "ref", entity, id });
  const q = (where: unknown) => ({ v: 1, where });

  beforeAll(async () => {
    w = await seedWorld();
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    const pm = await prisma.projectMember.findFirstOrThrow({ where: { projectId: w.P2.id }, select: { orgMember: { select: { userId: true } } } });
    ghost = pm.orgMember.userId;
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  it("who sees what: private, team, project, org, and co-editors", async () => {
    const p1 = q({ op: "cmp", field: { kind: "sys", id: "priority" }, cmp: "eq", value: { t: "str", v: "HIGH" } });
    await seed(w.bob.id, "bob private", p1);
    await seed(w.bob.id, "bob team", p1, { visibility: "TEAM", teamId: w.teamP1 });
    await seed(w.bob.id, "bob project P1", p1, { visibility: "PROJECT", projectId: w.P1.id });
    await seed(w.bob.id, "bob org", p1, { visibility: "ORG", shared: true });
    await seed(ghost, "ghost project P2", p1, { visibility: "PROJECT", projectId: w.P2.id });
    await seed(ghost, "ghost team P2", p1, { visibility: "TEAM", teamId: w.teamP2 });
    const coedited = await seed(w.bob.id, "bob private, actor edits", p1);
    await prisma.savedViewEditor.create({ data: { savedViewId: coedited, userId: w.actor.id } });

    as(() => actor());
    expect(await names()).toEqual(["bob org", "bob private, actor edits", "bob project P1"]);
    as(bob);
    expect(await names()).toEqual(["bob org", "bob private", "bob private, actor edits", "bob project P1", "bob team"]);
    // P1 is an open project, so ghost reads it too; bob's team is still bob's.
    as(() => user(ghost));
    expect(await names()).toEqual(["bob org", "bob project P1", "ghost project P2", "ghost team P2"]);
    // An id you can't see is the same 404 as one that doesn't exist.
    as(() => actor());
    const hidden = (await prisma.savedView.findFirstOrThrow({ where: { name: "bob team" } })).id;
    expect((await getOne(req(`saved-views/${hidden}`), { params: vparams(hidden) })).status).toBe(404);
    expect((await star(req(`saved-views/${hidden}/favorite`, "PUT", {}), { params: vparams(hidden) })).status).toBe(404);
  });

  it("shows a shared filter's text with what you can't read as ‹restricted›, and runs it narrowed", async () => {
    const id = await seed(ghost, "mixed", q({
      op: "and",
      args: [
        { op: "in", field: { kind: "sys", id: "project" }, values: [ref("project", w.P1.id), ref("project", w.P2.id)] },
        { op: "in", field: { kind: "sys", id: "sprint" }, values: [ref("interval", w.sprintP1Active), ref("interval", w.sprintP2Active)] },
      ],
    }), { visibility: "ORG", shared: true });
    as(() => actor());
    const res = await getOne(req(`saved-views/${id}`), { params: vparams(id) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cql: string; partiallyRestricted: boolean; filter: unknown };
    expect(body.partiallyRestricted).toBe(true);
    expect(body.cql).toContain(RESTRICTED);
    expect(body.cql).toContain(w.P1.key);
    // P2's "Sprint 1" is invisible to the actor, so for them the name means just P1's.
    expect(body.cql).toContain('"Sprint 1"');
    // The owner shared it with the org, so their name is meant to show; nothing
    // the filter refers to may.
    const raw = JSON.stringify({ ...body, ownerName: undefined });
    for (const s of w.secrets) expect(raw).not.toContain(s);
    expect(raw).not.toContain(w.P2.id);
    expect(raw).not.toContain(w.sprintP2Active);

    // Run by id: only what the actor can read.
    const run = await search(req(`work-items/search?filter=${id}`), { params: params() });
    expect(run.status).toBe(200);
    const rows = ((await run.json()) as { data: { project: { id: string } }[] }).data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.project.id === w.P1.id)).toBe(true);

    // ...and it can't be overwritten by someone who can't see all of it.
    as(() => actor(0n));
    await prisma.savedViewEditor.create({ data: { savedViewId: id, userId: w.actor.id } });
    const over = await patch(req(`saved-views/${id}`, "PATCH", { cql: "priority = LOW" }), { params: vparams(id) });
    expect(over.status).toBe(409);
    // The list carries no legacy filter for it either (its ids are what's withheld).
    const listed = ((await (await list(req("saved-views"), { params: params() })).json()) as { id: string; filter: object }[]).find((v) => v.id === id)!;
    expect(listed.filter).toEqual({});
  });

  it("?projectId= lists only the filters shared with that project", async () => {
    await seed(w.bob.id, "for P1 tab", q(null), { visibility: "PROJECT", projectId: w.P1.id });
    await seed(w.bob.id, "for P3 tab", q(null), { visibility: "PROJECT", projectId: w.P3.id });
    await seed(w.bob.id, "org wide, not a project's", q(null), { visibility: "ORG", shared: true });
    as(() => actor());
    const res = await list(req(`saved-views?projectId=${w.P1.id}`), { params: params() });
    const got = ((await res.json()) as { name: string }[]).map((v) => v.name);
    expect(got).toContain("for P1 tab");
    expect(got).not.toContain("for P3 tab");
    expect(got).not.toContain("org wide, not a project's");
    // A project you can't read lists nothing, rather than its filters.
    const hidden = ((await (await list(req(`saved-views?projectId=${w.P2.id}`), { params: params() })).json()) as unknown[]);
    expect(hidden).toEqual([]);
  });

  it("a filter on a custom field you can't see shows no text at all (the field's name would leak)", async () => {
    const key = `secretcf_${w.stamp}`;
    await prisma.customField.create({ data: { orgId: w.orgA, projectId: w.P2.id, key, name: `Secretfield ${w.stamp}`, fieldType: "TEXT" } });
    const id = await seed(ghost, "cf filter", q({ op: "cmp", field: { kind: "cf", key }, cmp: "eq", value: { t: "str", v: "x" } }), { visibility: "ORG", shared: true });
    as(() => actor());
    const body = (await (await getOne(req(`saved-views/${id}`), { params: vparams(id) })).json()) as { cql: string; partiallyRestricted: boolean; broken?: string };
    expect(body).toMatchObject({ cql: "", partiallyRestricted: true });
    expect(body.broken).toMatch(/fields you can't see/);
    expect(JSON.stringify(body)).not.toContain(key);
    // Its owner, who can see the field, gets the text.
    as(() => user(ghost));
    const own = (await (await getOne(req(`saved-views/${id}`), { params: vparams(id) })).json()) as { cql: string };
    expect(own.cql).toContain(key);
  });

  it("a name that would mean more than the stored thing prints as its id", async () => {
    // A second readable "Sprint 1" (in P3): the name now names two sprints.
    const dup = await prisma.interval.create({
      data: { orgId: w.orgA, projectId: w.P3.id, name: "Sprint 1", number: 9, status: "ACTIVE", startDate: new Date("2026-10-01"), endDate: new Date("2026-10-14") },
      select: { id: true },
    });
    try {
      const id = await seed(w.actor.id, "one sprint", q({ op: "cmp", field: { kind: "sys", id: "sprint" }, cmp: "eq", value: ref("interval", w.sprintP1Active) }));
      as(() => actor());
      const body = (await (await getOne(req(`saved-views/${id}`), { params: vparams(id) })).json()) as { cql: string };
      // Bare or quoted, depending on whether the uuid starts with a digit.
      expect(body.cql).toMatch(new RegExp(`^sprint = "?${w.sprintP1Active}"?$`));
      // ...and that text runs as exactly the stored sprint.
      const ids = async (qs: string) =>
        ((await (await search(req(`work-items/search?${qs}`), { params: params() })).json()) as { data: { id: string }[] }).data.map((r) => r.id).sort();
      const byText = await ids(`cql=${encodeURIComponent(body.cql)}`);
      expect(byText).toEqual(await ids(`filter=${id}`));
      expect(byText.length).toBeGreaterThan(0);
    } finally {
      await prisma.interval.delete({ where: { id: dup.id } });
    }
  });

  it("without CQL, a shared filter naming something you can't read isn't listed (#1093's rule)", async () => {
    await seed(ghost, "legacy secret", null, { filter: { projectIds: [w.P2.id] }, visibility: "ORG", shared: true });
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, false) as object } });
    try {
      as(() => actor());
      expect(await names()).not.toContain("legacy secret");
      as(() => user(ghost));
      expect(await names()).toContain("legacy secret");
      // An administrator reads every project, so sees it.
      getAuthContext.mockImplementation(async () => ({ ...actor(), orgRole: OrgRole.ADMIN }) as AuthContext);
      expect(await names()).toContain("legacy secret");
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    }
    // With CQL it's listed (and redacted when opened).
    as(() => actor());
    expect(await names()).toContain("legacy secret");
  });

  it("saves CQL resolved, with the legacy shape alongside while it can say it", async () => {
    as(() => actor());
    const res = await create(req("saved-views", "POST", { name: "mine high", cql: `project = ${w.P1.key} AND priority = HIGH` }), { params: params() });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { id: string; filter: { projectIds?: string[]; priorities?: string[] }; visibility: string };
    expect(dto.visibility).toBe("PRIVATE");
    expect(dto.filter).toEqual({ projectIds: [w.P1.id], priorities: ["HIGH"] });
    const row = await prisma.savedView.findUniqueOrThrow({ where: { id: dto.id } });
    expect(JSON.stringify(row.query)).toContain(w.P1.id);
    expect(row.cqlText).toBe(`project = ${w.P1.key} AND priority = HIGH`);

    // Beyond the legacy shape: stored, and `filter` is {} rather than wrong.
    const wide = await create(req("saved-views", "POST", { name: "mine or", cql: "priority = HIGH OR assignee = me" }), { params: params() });
    expect(((await wide.json()) as { filter: object }).filter).toEqual({});
    // An unknown value is a positioned 400, nothing saved.
    const bad = await create(req("saved-views", "POST", { name: "bad", cql: "sprint = Nosuchsprint" }), { params: params() });
    expect(bad.status).toBe(400);
    expect(await prisma.savedView.count({ where: { name: "bad" } })).toBe(0);
  });

  it("sharing: ORG needs FILTER_SHARE_ORG; PROJECT and TEAM need to see them (and be on the team)", async () => {
    as(() => actor());
    const post = (body: object) => create(req("saved-views", "POST", { cql: "priority = LOW", ...body }), { params: params() });
    expect((await post({ name: "s1", visibility: "ORG" })).status).toBe(403);
    // The legacy picker's "share" asks for the same thing.
    expect((await create(req("saved-views", "POST", { name: "s1legacy", filter: {}, shared: true }), { params: params() })).status).toBe(403);
    as(() => actor(Permission.FILTER_SHARE_ORG));
    expect((await post({ name: "s1", visibility: "ORG" })).status).toBe(201);
    expect(await prisma.auditLog.count({ where: { orgId: w.orgA, action: "saved_filter.shared_org" } })).toBeGreaterThan(0);
    as(() => actor());
    expect((await post({ name: "s2", visibility: "PROJECT", projectId: w.P2.id })).status).toBe(403);
    expect((await post({ name: "s3", visibility: "PROJECT", projectId: w.P1.id })).status).toBe(201);
    // Not on Platform, not a P1 manager.
    expect((await post({ name: "s4", visibility: "TEAM", teamId: w.teamP1 })).status).toBe(403);
    as(bob);
    expect((await post({ name: "s4", visibility: "TEAM", teamId: w.teamP1 })).status).toBe(201);
    // An admin may share with a team they manage the project of.
    as(() => actor(0n));
    getAuthContext.mockImplementationOnce(async () => ({ ...actor(), orgRole: OrgRole.ADMIN }) as AuthContext);
    expect((await post({ name: "s5", visibility: "TEAM", teamId: w.teamP1 })).status).toBe(201);
  });

  it("editors edit the query, not who sees it; admins change owner; owners delete", async () => {
    const id = await seed(w.bob.id, "bob shared edit", q(null));
    await prisma.savedViewEditor.create({ data: { savedViewId: id, userId: w.actor.id } });
    as(() => actor());
    const ok = await patch(req(`saved-views/${id}`, "PATCH", { cql: "priority = CRITICAL", description: "urgent" }), { params: vparams(id) });
    expect(ok.status).toBe(200);
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id } })).description).toBe("urgent");
    expect((await patch(req(`saved-views/${id}`, "PATCH", { visibility: "PRIVATE", editorIds: [] }), { params: vparams(id) })).status).toBe(403);
    expect((await remove(req(`saved-views/${id}`, "DELETE"), { params: vparams(id) })).status).toBe(403);
    expect((await patch(req(`saved-views/${id}`, "PATCH", { ownerId: w.actor.id }), { params: vparams(id) })).status).toBe(403);

    getAuthContext.mockImplementation(async () => ({ ...user(w.alex1.id), orgRole: OrgRole.ADMIN }) as AuthContext);
    const moved = await patch(req(`saved-views/${id}`, "PATCH", { ownerId: w.actor.id }), { params: vparams(id) });
    expect(moved.status).toBe(200);
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id } })).ownerId).toBe(w.actor.id);
    as(() => actor());
    expect((await remove(req(`saved-views/${id}`, "DELETE"), { params: vparams(id) })).status).toBe(204);
  });

  it("the legacy PUT still renames and re-shares, and the legacy fields stay derived", async () => {
    as(() => actor(Permission.FILTER_SHARE_ORG));
    const made = (await (await create(req("saved-views", "POST", { name: "legacy one", filter: { priorities: ["LOW"] } }), { params: params() })).json()) as { id: string };
    const res = await legacyPut(req(`saved-views/${made.id}`, "PUT", { name: "legacy renamed", shared: true }), { params: vparams(made.id) });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { name: string; shared: boolean; visibility: string; filter: unknown };
    expect(dto).toMatchObject({ name: "legacy renamed", shared: true, visibility: "ORG", filter: { priorities: ["LOW"] } });
  });

  it("stars: one per user per filter, ordered, and gone with the filter", async () => {
    const a = await seed(w.actor.id, "star a", q(null));
    const b = await seed(w.actor.id, "star b", q(null));
    as(() => actor());
    expect((await star(req(`saved-views/${a}/favorite`, "PUT", {}), { params: vparams(a) })).status).toBe(200);
    const second = (await (await star(req(`saved-views/${b}/favorite`, "PUT", {}), { params: vparams(b) })).json()) as { sortOrder: number };
    // Starring again is idempotent.
    expect((await star(req(`saved-views/${a}/favorite`, "PUT", {}), { params: vparams(a) })).status).toBe(200);
    expect(await prisma.savedViewFavorite.count({ where: { userId: w.actor.id, savedViewId: { in: [a, b] } } })).toBe(2);
    const listed = ((await (await list(req("saved-views"), { params: params() })).json()) as { id: string; favorite: boolean; favoriteOrder: number | null }[]).filter((v) => v.id === a || v.id === b);
    expect(listed.every((v) => v.favorite)).toBe(true);
    expect(second.sortOrder).toBeGreaterThan(listed.find((v) => v.id === a)!.favoriteOrder!);
    expect((await unstar(req(`saved-views/${a}/favorite`, "DELETE"), { params: vparams(a) })).status).toBe(204);
    await prisma.savedView.delete({ where: { id: b } });
    expect(await prisma.savedViewFavorite.count({ where: { savedViewId: { in: [a, b] } } })).toBe(0);
  });

  it("a filter saved before phase 3 (no `query`) still opens and runs, from its legacy filter", async () => {
    const id = await seed(w.actor.id, "old style", null, { filter: { priorities: ["CRITICAL"] } });
    as(() => actor());
    const body = (await (await getOne(req(`saved-views/${id}`), { params: vparams(id) })).json()) as { cql: string; partiallyRestricted: boolean };
    expect(body.cql).toBe("priority IN (CRITICAL)");
    expect(body.partiallyRestricted).toBe(false);
    const run = await search(req(`work-items/search?filter=${id}`), { params: params() });
    expect(((await run.json()) as { data: { priority: string }[] }).data.every((r) => r.priority === "CRITICAL")).toBe(true);
  });

  it("never names a project or team the viewer can't read: co-editors and ABAC-limited admins see null", async () => {
    // Rows from before the editor rule below: the actor co-edits ghost's
    // filters on P2, which the actor can't read.
    const onP2 = await seed(ghost, "ghost on P2, actor edits", q(null), { visibility: "PROJECT", projectId: w.P2.id });
    const onTeam = await seed(ghost, "ghost on secret team, actor edits", q(null), { visibility: "TEAM", teamId: w.teamP2 });
    for (const id of [onP2, onTeam]) await prisma.savedViewEditor.create({ data: { savedViewId: id, userId: w.actor.id } });

    // Ghost owns these and added the actor, so ghost's name is meant to show.
    const noSecrets = (body: unknown) => {
      const raw = JSON.stringify(body).replaceAll(/"ownerName":"[^"]*"/g, "");
      for (const secret of w.secrets) expect(raw).not.toContain(secret);
      expect(raw).not.toContain(w.P2.id);
      expect(raw).not.toContain(w.teamP2);
    };
    const opened = async (id: string) => {
      const res = await getOne(req(`saved-views/${id}`), { params: vparams(id) });
      expect(res.status).toBe(200);
      return (await res.json()) as { project: unknown; team: unknown; partiallyRestricted: boolean };
    };

    as(() => actor());
    for (const id of [onP2, onTeam]) {
      const body = await opened(id);
      expect(body).toMatchObject({ project: null, team: null, partiallyRestricted: true });
      noSecrets(body);
    }
    const listed = ((await (await list(req("saved-views"), { params: params() })).json()) as { id: string }[]).filter((v) => v.id === onP2 || v.id === onTeam);
    expect(listed).toHaveLength(2);
    noSecrets(listed);
    // `?projectId=` doesn't confirm a project you can't read exists.
    expect(await (await list(req(`saved-views?projectId=${w.P2.id}`), { params: params() })).json()).toEqual([]);

    // An administrator an ABAC policy keeps out of P2 can still open (and
    // manage) the filter, but not learn P2's name through it.
    const fencedAdmin = () =>
      ({ ...user(w.alex1.id), orgRole: OrgRole.ADMIN, abacRules: [{ effect: "deny", actions: ["ITEM_READ"], conditions: [{ attr: "projectId", op: "eq", value: w.P2.id }] }] }) as AuthContext;
    as(fencedAdmin);
    for (const id of [onP2, onTeam]) {
      const body = await opened(id);
      expect(body).toMatchObject({ project: null, team: null, partiallyRestricted: true });
      noSecrets(body);
    }

    // Someone who can read P2 sees the target named.
    as(() => user(ghost));
    expect(await opened(onP2)).toMatchObject({ project: { id: w.P2.id, key: w.P2.key }, partiallyRestricted: false });
    expect(await opened(onTeam)).toMatchObject({ team: { id: w.teamP2 }, partiallyRestricted: false });
  });

  it("an editor must be able to read the project or team a filter is shared with", async () => {
    as(() => user(ghost));
    const post = (body: object) => create(req("saved-views", "POST", { cql: "priority = LOW", ...body }), { params: params() });
    const refused = await post({ name: "ghost P2 + actor", visibility: "PROJECT", projectId: w.P2.id, editorIds: [w.actor.id] });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/can't see the project/);
    expect((await post({ name: "ghost team + actor", visibility: "TEAM", teamId: w.teamP2, editorIds: [w.actor.id] })).status).toBe(400);
    expect(await prisma.savedView.count({ where: { name: { in: ["ghost P2 + actor", "ghost team + actor"] } } })).toBe(0);

    // Adding one later, or moving a filter onto P2 while the actor edits it.
    const made = (await (await post({ name: "ghost P2 alone", visibility: "PROJECT", projectId: w.P2.id })).json()) as { id: string };
    expect((await patch(req(`saved-views/${made.id}`, "PATCH", { editorIds: [w.actor.id] }), { params: vparams(made.id) })).status).toBe(400);
    const priv = (await (await post({ name: "ghost private + actor", editorIds: [w.actor.id] })).json()) as { id: string };
    expect((await patch(req(`saved-views/${priv.id}`, "PATCH", { visibility: "PROJECT", projectId: w.P2.id }), { params: vparams(priv.id) })).status).toBe(400);
    expect((await prisma.savedView.findUniqueOrThrow({ where: { id: priv.id } })).visibility).toBe("PRIVATE");
    // An open project is fine.
    expect((await patch(req(`saved-views/${priv.id}`, "PATCH", { visibility: "PROJECT", projectId: w.P1.id }), { params: vparams(priv.id) })).status).toBe(200);
  });

  it("orgs without CQL keep the old rule: any member may share a filter with everyone", async () => {
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, false) as object } });
    try {
      as(() => actor());
      const res = await create(req("saved-views", "POST", { name: "legacy shared, no CQL", filter: {}, shared: true }), { params: params() });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { shared: boolean }).shared).toBe(true);
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    }
  });

  it("audits an owner change only once it has happened", async () => {
    const id = await seed(w.bob.id, "audit owner", q(null));
    const audited = () => prisma.auditLog.count({ where: { orgId: w.orgA, entityId: id, action: "saved_filter.owner_changed" } });
    getAuthContext.mockImplementation(async () => ({ ...user(w.alex1.id), orgRole: OrgRole.ADMIN }) as AuthContext);
    // Refused after the owner change was accepted: an editor who can't read P2.
    const refused = await patch(req(`saved-views/${id}`, "PATCH", { ownerId: ghost, visibility: "PROJECT", projectId: w.P2.id, editorIds: [w.actor.id] }), { params: vparams(id) });
    expect(refused.status).toBe(400);
    // The update itself throws (a name the new owner already has, raced past the check).
    const update = vi.spyOn(prisma.savedView, "update").mockRejectedValueOnce(new Error("write failed"));
    const thrown = await patch(req(`saved-views/${id}`, "PATCH", { ownerId: w.actor.id }), { params: vparams(id) });
    update.mockRestore();
    expect(thrown.status).toBe(500);
    expect(await audited()).toBe(0);
    expect((await patch(req(`saved-views/${id}`, "PATCH", { ownerId: w.actor.id }), { params: vparams(id) })).status).toBe(200);
    expect(await audited()).toBe(1);
  });
});
