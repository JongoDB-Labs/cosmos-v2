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
// names teams and projects, never people.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { withCqlEnabled } from "../flag";
import { executeCql, MAX_LIST_VALUES } from "../execute.server";
import { seedWorld, type World } from "./cql-fixture";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
import { POST as predicateRoute } from "@/app/api/v1/orgs/[orgId]/cql/predicate/route";

const TEAM_QUERIES = ["team = Platform", "team != Platform", "team IS EMPTY"] as const;

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

  for (const cql of TEAM_QUERIES) {
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
});
