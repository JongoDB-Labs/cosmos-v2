// @vitest-environment node
//
// (e2e DB) `team` without the roster in the query.
//
// `team = X` is "tagged with X, or untagged and assigned to someone on X in X's
// project" (lib/teams/item-teams.ts). The compiler used to spell the second
// half out as every member's user id. Two things followed:
//
//  - Past 30,000 members (MAX_LIST_VALUES) every team query, `team = X`,
//    `team != X` and `team IS EMPTY`, was refused as too broad: one large team
//    anywhere in the readable projects took the field away from everyone.
//  - The ids went out in `POST cql/predicate`, the compiled where a board
//    evaluates in the browser, so anyone allowed to filter by team, a guest
//    included, received the user id of everyone on every readable team.
//
// The item now reaches its assignee's teams through a relation, so the where
// names teams and projects, never people. `membersOf(X)` had the same two
// problems and takes the same join wherever the field has a relation to the
// person; the uses that don't (reporter, mentions, history) keep the people on
// the server and leave the clause to the server's ids in a browser predicate.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { withCqlEnabled } from "../flag";
import { executeCql, predicateCql, MAX_LIST_VALUES } from "../execute.server";
import { UNDECIDED, matches } from "../evaluate";
import { seedWorld, type World } from "./cql-fixture";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
import { POST as predicateRoute } from "@/app/api/v1/orgs/[orgId]/cql/predicate/route";

const TEAM_QUERIES = ["team = Platform", "team != Platform", "team IS EMPTY"] as const;
/** `membersOf()` where the field reaches the person through a relation: a join to the team. */
const JOINED_MEMBERS_QUERIES = [
  "assignee IN membersOf(Platform)",
  "assignee NOT IN membersOf(Platform)",
  "primaryAssignee IN membersOf(Platform)",
  "watcher IN membersOf(Platform)",
] as const;
/** `membersOf()` where the field stores bare ids: the people, on the server only. */
const PEOPLE_MEMBERS_QUERIES = [
  "reporter IN membersOf(Platform)",
  "mentions IN membersOf(Platform)",
  "priority CHANGED BY membersOf(Platform)",
  "assignee WAS IN membersOf(Platform)",
] as const;

/** An untagged P1 item, made directly (no history row). */
async function mkP1Item(w: World, ticketNumber: number, title: string, data: Record<string, unknown> = {}) {
  return prisma.workItem.create({
    data: {
      orgId: w.orgA, projectId: w.P1.id, ticketNumber, title, description: "", columnKey: "todo",
      workItemTypeId: w.typeTask, createdById: w.actor.id, ...data,
    },
  });
}

/** Puts a fixture user on Platform (P1's team), through a P1 project membership. */
async function joinPlatform(w: World, userId: string) {
  const om = await prisma.orgMember.findFirstOrThrow({ where: { orgId: w.orgA, userId } });
  const pm = await prisma.projectMember.create({ data: { projectId: w.P1.id, orgMemberId: om.id } });
  await prisma.teamMember.create({ data: { teamId: w.teamP1, projectMemberId: pm.id } });
  return om.id;
}

describe("a team larger than the list-value cap (e2e DB)", () => {
  /** One more member than a query may carry as list values. */
  const N = MAX_LIST_VALUES + 1;
  let w: World;
  let tag: string;
  let scaleItem: string;

  beforeAll(async () => {
    w = await seedWorld();
    tag = `teamscale${w.stamp}`;
    // N users on Platform (P1), each a member of the org and the project.
    await prisma.$executeRaw`INSERT INTO users (id, email, display_name)
      SELECT gen_random_uuid(), ${tag} || '-' || g || '@test.local', 'Scale ' || g FROM generate_series(1, ${N}::int) g`;
    await prisma.$executeRaw`INSERT INTO org_members (id, org_id, user_id)
      SELECT gen_random_uuid(), ${w.orgA}::uuid, u.id FROM users u WHERE u.email LIKE ${`${tag}-%`}`;
    await prisma.$executeRaw`INSERT INTO project_members (id, project_id, org_member_id)
      SELECT gen_random_uuid(), ${w.P1.id}::uuid, m.id FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE u.email LIKE ${`${tag}-%`}`;
    await prisma.$executeRaw`INSERT INTO team_members (id, team_id, project_member_id)
      SELECT gen_random_uuid(), ${w.teamP1}::uuid, pm.id FROM project_members pm
      JOIN org_members m ON m.id = pm.org_member_id JOIN users u ON u.id = m.user_id
      WHERE u.email LIKE ${`${tag}-%`}`;
    // An untagged item assigned to one of them: Platform's work by the team rule.
    const someone = await prisma.user.findFirstOrThrow({ where: { email: `${tag}-1@test.local` }, select: { id: true } });
    scaleItem = (
      await prisma.workItem.create({
        data: {
          orgId: w.orgA, projectId: w.P1.id, ticketNumber: 801, title: "untagged, assigned to a big-team member",
          description: "", columnKey: "todo", workItemTypeId: w.typeTask, createdById: w.actor.id, assigneeId: someone.id,
        },
      })
    ).id;
  }, 300_000);

  afterAll(async () => {
    await w?.cleanup();
    await prisma.$executeRaw`DELETE FROM users WHERE email LIKE ${`${tag}-%`}`;
  }, 300_000);

  /** Within P1, where the big team is. An empty `cql` is all of P1. */
  const run = async (cql: string) => {
    const scoped = cql ? `${cql} AND project = ${w.P1.key}` : `project = ${w.P1.key}`;
    const r = await executeCql(w.ctx(), { cql: scoped }, { pageSize: 100, timeoutMs: 20_000 });
    if (r.total === null) throw new Error(`no count for ${scoped}`);
    return { total: r.total, ids: r.data.map((d) => (d as { id: string }).id) };
  };

  it("the team really is larger than the cap", async () => {
    expect(await prisma.teamMember.count({ where: { teamId: w.teamP1 } })).toBeGreaterThan(MAX_LIST_VALUES);
  });

  it("`team = X`, `team != X` and `team IS EMPTY` all run, and the big team's untagged work is its own", async () => {
    const [is, isNot, empty] = await Promise.all(TEAM_QUERIES.map(run));
    expect(is.ids).toContain(scaleItem);
    expect(isNot.ids).not.toContain(scaleItem);
    expect(empty.ids).not.toContain(scaleItem);
    // An item is the team's, another team's, or no team's: the three are a partition.
    const all = await run("");
    expect(is.total + isNot.total + empty.total).toBe(all.total);
    expect(is.total).toBeGreaterThan(0);
    expect(empty.total).toBeGreaterThan(0);
  }, 120_000);
});

describe("a guest's compiled team filter (e2e DB)", () => {
  let w: World;

  beforeAll(async () => {
    w = await seedWorld();
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
  }, 60_000);
  afterAll(async () => {
    getAuthContext.mockReset();
    await w?.cleanup();
  });

  /** What `POST cql/predicate` sends a guest's browser for this query. */
  async function predicateAsGuest(cql: string): Promise<{ status: number; text: string }> {
    getAuthContext.mockImplementation(async () => w.ctx({ role: OrgRole.GUEST }));
    const res = await predicateRoute(
      new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/cql/predicate`, {
        method: "POST",
        body: JSON.stringify({ cql }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ orgId: w.orgA }) },
    );
    return { status: res.status, text: await res.text() };
  }

  it("the check can see a user id in a predicate at all (positive control)", async () => {
    const { status, text } = await predicateAsGuest(`assignee = "Bob Builder"`);
    expect(status).toBe(200);
    expect(text).toContain(w.bob.id);
  });

  for (const cql of [...TEAM_QUERIES, ...JOINED_MEMBERS_QUERIES]) {
    it(`\`${cql}\` names the team and none of the people on it`, async () => {
      const { status, text } = await predicateAsGuest(cql);
      expect(status).toBe(200);
      // Bob is on Platform; the others are org members on no readable team.
      for (const user of [w.bob.id, w.alex1.id, w.alex2.id]) expect(text).not.toContain(user);
      // The team clause is there: this is not passing on an empty answer.
      expect(text).toContain(w.teamP1);
      // Nor a team in a project the actor can't read (P2 is team-scoped).
      expect(text).not.toContain(w.teamP2);
    });
  }

  for (const cql of PEOPLE_MEMBERS_QUERIES) {
    it(`\`${cql}\` leaves the clause to the server rather than send the people`, async () => {
      const { status, text } = await predicateAsGuest(cql);
      expect(status).toBe(200);
      for (const user of [w.bob.id, w.alex1.id, w.alex2.id]) expect(text).not.toContain(user);
      // The clause is there, as the server's: not passing on an empty answer.
      expect(text).toContain("$serverOnly");
    });
  }

});

describe("membersOf() means the team's current members (e2e DB)", () => {
  let w: World;
  /** Items a current member (Bob) is on, one per field; and the same for someone who left. */
  const bobs: Record<string, string> = {};
  const leavers: Record<string, string> = {};

  beforeAll(async () => {
    w = await seedWorld();
    // Bob is on Platform. alex2 was on it too, and has left the org: the
    // membership rows stay (a soft delete), and none of it is the team's any more.
    const leftId = await joinPlatform(w, w.alex2.id);
    await prisma.orgMember.update({ where: { id: leftId }, data: { removedAt: new Date("2026-10-01T00:00:00Z") } });

    let n = 900;
    for (const [who, user, out] of [["bob", w.bob.id, bobs], ["leaver", w.alex2.id, leavers]] as const) {
      out.primary = (await mkP1Item(w, n++, `${who}: primary assignee`, { assigneeId: user })).id;
      const co = await mkP1Item(w, n++, `${who}: co-assignee`);
      await prisma.workItemAssignee.create({ data: { workItemId: co.id, userId: user, sortOrder: 0 } });
      out.co = co.id;
      const watched = await mkP1Item(w, n++, `${who}: watcher`);
      await prisma.workItemWatcher.create({ data: { orgId: w.orgA, workItemId: watched.id, userId: user } });
      out.watched = watched.id;
      out.reported = (await mkP1Item(w, n++, `${who}: reporter`, { createdById: user })).id;
      out.mentioned = (await mkP1Item(w, n++, `${who}: mentioned`, { description: `ask <@${user}>` })).id;
      const changed = await mkP1Item(w, n++, `${who}: changed priority`);
      await prisma.activity.create({
        data: { orgId: w.orgA, workItemId: changed.id, userId: user, action: "updated", field: "priority", oldValue: "LOW", newValue: "HIGH" },
      });
      out.changed = changed.id;
      const was = await mkP1Item(w, n++, `${who}: was assigned`);
      await prisma.activity.create({
        data: { orgId: w.orgA, workItemId: was.id, userId: w.actor.id, action: "updated", field: "assigneeId", oldValue: user, newValue: null },
      });
      out.was = was.id;
    }
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const idsOf = async (cql: string) =>
    new Set((await executeCql(w.ctx(), { cql: `(${cql}) AND project = ${w.P1.key}` }, { pageSize: 100 })).data.map((r) => r.id));

  // Each `membersOf(Platform)` query against the same query naming Platform's
  // one current member: what `membersOf()` meant when it listed the people.
  const PAIRS: [string, string, keyof typeof bobs | null][] = [
    ["assignee IN membersOf(Platform)", 'assignee IN ("Bob Builder")', "primary"],
    ["assignee NOT IN membersOf(Platform)", 'assignee NOT IN ("Bob Builder")', null],
    ["primaryAssignee IN membersOf(Platform)", 'primaryAssignee IN ("Bob Builder")', "primary"],
    ["watcher IN membersOf(Platform)", 'watcher IN ("Bob Builder")', "watched"],
    ["reporter IN membersOf(Platform)", 'reporter IN ("Bob Builder")', "reported"],
    ["mentions IN membersOf(Platform)", 'mentions IN ("Bob Builder")', "mentioned"],
    ["priority CHANGED BY membersOf(Platform)", 'priority CHANGED BY "Bob Builder"', "changed"],
    ["assignee WAS IN membersOf(Platform)", 'assignee WAS IN ("Bob Builder")', "was"],
  ];
  for (const [members, named, field] of PAIRS) {
    it(`\`${members}\` matches what naming the current members matches`, async () => {
      const [got, want] = await Promise.all([idsOf(members), idsOf(named)]);
      expect([...got].sort()).toEqual([...want].sort());
      expect(want.size).toBeGreaterThan(0);
      if (field) {
        // Bob's item is in; the item of the one who left is not.
        expect(got).toContain(bobs[field]);
        expect(got).not.toContain(leavers[field]);
      }
    });
  }

  it("the co-assignee counts for `assignee`, not for `primaryAssignee`", async () => {
    expect(await idsOf("assignee IN membersOf(Platform)")).toContain(bobs.co);
    expect(await idsOf("assignee IN membersOf(Platform)")).not.toContain(leavers.co);
    expect(await idsOf("primaryAssignee IN membersOf(Platform)")).not.toContain(bobs.co);
  });

  it("a board can't decide the people-bearing clauses itself, so it asks the server", async () => {
    for (const cql of PEOPLE_MEMBERS_QUERIES) {
      const { where } = await predicateCql(w.ctx(), { cql }, {});
      const row = await prisma.workItem.findUniqueOrThrow({ where: { id: bobs.reported } });
      expect(matches(where, JSON.parse(JSON.stringify(row))), cql).toBe(UNDECIDED);
    }
  });
});

describe("someone who leaves the org takes their untagged work off the team (e2e DB)", () => {
  let w: World;
  beforeAll(async () => {
    w = await seedWorld();
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  it("is the team's while they are a member, and no longer once they have left", async () => {
    const memberId = await joinPlatform(w, w.alex1.id);
    const item = await mkP1Item(w, 950, "untagged, assigned to someone who will leave", { assigneeId: w.alex1.id });
    const run = async (cql: string) =>
      (await executeCql(w.ctx(), { cql: `(${cql}) AND project = ${w.P1.key}` }, { pageSize: 100 })).data.map((r) => r.id);

    // Positive control: a member's untagged work is the team's.
    expect(await run("team = Platform")).toContain(item.id);
    expect(await run("assignee IN membersOf(Platform)")).toContain(item.id);
    expect(await run("team IS EMPTY")).not.toContain(item.id);

    // They leave: the membership rows stay (a soft delete) and no longer count.
    await prisma.orgMember.update({ where: { id: memberId }, data: { removedAt: new Date() } });
    expect(await run("team = Platform")).not.toContain(item.id);
    expect(await run("assignee IN membersOf(Platform)")).not.toContain(item.id);
    expect(await run("team IS EMPTY")).toContain(item.id);
  });
});
