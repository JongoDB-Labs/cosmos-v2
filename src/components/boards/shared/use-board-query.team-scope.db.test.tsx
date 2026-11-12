// @vitest-environment jsdom
//
// (e2e DB) A board with the query language on, filtered to a team, shows that
// team's work: the items tagged with the team AND the untagged items assigned
// to someone on it. The filter bar (query language off), its swimlanes and
// Cosmo's team filter have always read a team that way (lib/teams/item-teams.ts);
// `team = X` compared the item's own team column only, so picking a team with
// the query language on hid every item nobody had tagged.
//
// Four items decide the rule:
//   tagged with the team ............................ in
//   untagged, assigned to a member .................. in
//   untagged, assigned to a non-member .............. out
//   tagged with ANOTHER team, assigned to a member .. out (an item's own team wins)
//
// This drives the real hook. Its requests (`cql/predicate`, and the ids-only
// fallback) are answered by the same server functions the routes call, against
// this database, so the resolver, the compiler, the scope envelope and the
// in-browser interpreter are all real. The legacy filter bar is run over the
// same rows and must agree.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => nav.search,
  usePathname: () => "/acme/projects/P1/boards/b1",
}));
vi.mock("@/lib/query/json-fetcher", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { prisma } from "@/lib/db/client";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { idsCql, predicateCql } from "@/lib/query/execute.server";
import { FIELDS } from "@/lib/query/fields";
import { FUNCTIONS } from "@/lib/query/functions";
import { seedWorld, type World } from "@/lib/query/__tests__/cql-fixture";
import { matchesFilters } from "@/lib/work-items/board-filters";
import { emptyFilters } from "@/components/boards/shared/filter-bar";
import { teamsByUser, type TeamLike } from "@/lib/teams/item-teams";
import { CQL_VERSION } from "@/lib/query/ast";
import type { WorkItem } from "@/types/models";
import { useBoardQuery } from "./use-board-query";

const SCHEMA = { version: 1, fields: FIELDS.map((f) => ({ ...f, sortable: !!f.sortable, groupable: !!f.groupable })), customFields: [], functions: FUNCTIONS };

describe("a board filtered to a team (e2e DB)", () => {
  let w: World;
  let otherTeam: string;
  /** The project's items as the board's own fetch delivers them. */
  let rows: Record<string, unknown>[];
  /** The project's teams as the board's teams route delivers them. */
  let teams: TeamLike[];
  let inflight = 0;

  beforeAll(async () => {
    w = await seedWorld();
    // A second team in the same project, so "tagged with another team" is real.
    otherTeam = (await prisma.team.create({ data: { orgId: w.orgA, projectId: w.P1.id, name: `Mobile ${w.stamp}` } })).id;
    const mkItem = (title: string, ticketNumber: number, data: Record<string, unknown>) =>
      prisma.workItem.create({
        data: {
          orgId: w.orgA, projectId: w.P1.id, ticketNumber, title, description: "", columnKey: "todo",
          workItemTypeId: w.typeTask, createdById: w.actor.id, ...data,
        },
      });
    // Bob is on Platform (the fixture's teamP1); alex1 is on no team.
    await mkItem("tagged with the team", 701, { teamId: w.teamP1, assigneeId: w.alex1.id });
    await mkItem("untagged, assigned to a member", 702, { assigneeId: w.bob.id });
    await mkItem("untagged, assigned to a non-member", 703, { assigneeId: w.alex1.id });
    await mkItem("tagged with another team, assigned to a member", 704, { teamId: otherTeam, assigneeId: w.bob.id });

    rows = JSON.parse(
      JSON.stringify(
        await prisma.workItem.findMany({
          where: { orgId: w.orgA, projectId: w.P1.id, archivedAt: null },
          omit: { searchVector: true },
          include: {
            parent: { select: { id: true, title: true, ticketNumber: true, workItemTypeId: true } },
            children: { select: { id: true, title: true, columnKey: true, ticketNumber: true, workItemTypeId: true, completedAt: true } },
            workItemType: { select: { id: true, key: true, name: true, icon: true, color: true } },
            assignees: { select: { userId: true, user: { select: { id: true, displayName: true, avatarUrl: true } } } },
          },
        }),
      ),
    );
    // The board's teams route: team -> members -> project member -> org member.
    teams = (
      await prisma.team.findMany({
        where: { projectId: w.P1.id },
        select: { id: true, name: true, members: { select: { projectMember: { select: { orgMember: { select: { userId: true } } } } } } },
      })
    ).map((t) => ({ id: t.id, name: t.name, members: t.members.map((m) => ({ userId: m.projectMember.orgMember.userId })) }));

    vi.mocked(jsonFetch).mockImplementation((async (url: string, init?: RequestInit) => {
      if (url.endsWith("/query-language")) return { enabled: true, canManage: false };
      if (url.endsWith("/cql/schema")) return SCHEMA;
      // Diagnostics for the bar only; they decide nothing about the rows.
      if (url.endsWith("/cql/validate")) return { valid: true, diagnostics: [] };
      const body = JSON.parse(String(init?.body ?? "{}"));
      const opts = { tz: body.tz, contextProjectId: body.contextProjectId };
      inflight++;
      try {
        if (url.endsWith("/cql/predicate")) return await predicateCql(w.ctx(), { query: body.query }, opts);
        if (url.endsWith("/work-items/query") && body.idsOnly) return await idsCql(w.ctx(), { query: body.query }, opts);
        throw new Error(`unexpected request ${url}`);
      } finally {
        inflight--;
      }
    }) as never);
  }, 60_000);
  afterAll(async () => {
    vi.mocked(jsonFetch).mockReset();
    await w?.cleanup();
  });
  afterEach(() => {
    cleanup();
    nav.search = new URLSearchParams();
  });

  const titleOf = (id: string) => (rows.find((r) => r.id === id)?.title as string) ?? id;
  const titles = (ids: Iterable<string>) => [...ids].map(titleOf).sort();

  /** What the board shows with the query language on, given the bar's text and the board's saved config. */
  async function boardShows(opts: { cql?: string; config?: unknown }): Promise<{ shows: string[]; scopeLine: string | null }> {
    nav.search = new URLSearchParams(opts.cql ? { cql: opts.cql } : {});
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useBoardQuery({ orgId: w.orgA, projectId: w.P1.id, config: opts.config, rows }), { wrapper });
    const asked = () => vi.mocked(jsonFetch).mock.calls.filter(([u]) => String(u).endsWith("/cql/predicate")).length;
    const before = asked();
    await waitFor(
      () => {
        expect(asked()).toBeGreaterThan(before);
        expect(inflight).toBe(0);
        expect(result.current.pending).toBe(false);
      },
      { timeout: 15_000 },
    );
    return {
      shows: titles(rows.filter((r) => result.current.keep(r as { id: string })).map((r) => r.id as string)),
      scopeLine: result.current.baselineCql,
    };
  }

  /** What the board shows with the query language off: the filter bar's team clause. */
  function filterBarShows(teamId: string): string[] {
    const f = { ...emptyFilters, teamId };
    return titles(
      rows
        .filter((r) => matchesFilters(r as unknown as WorkItem, f, [], teamsByUser(teams), new Date()))
        .map((r) => r.id as string),
    );
  }

  // The fixture's own P1 items count too: p1-login-bug is tagged Platform, and
  // p1-done's primary assignee is Bob. p1-coowned has Bob only as a
  // co-assignee, which is not the team rule (primary assignee only).
  const PLATFORM = [
    "p1-done",
    "p1-login-bug",
    "tagged with the team",
    "untagged, assigned to a member",
  ];

  it("the fixture is what the cases below need", () => {
    const by = (t: string) => rows.find((r) => r.title === t)!;
    expect(by("tagged with the team").teamId).toBe(w.teamP1);
    expect(by("untagged, assigned to a member")).toMatchObject({ teamId: null, assigneeId: w.bob.id });
    expect(by("untagged, assigned to a non-member")).toMatchObject({ teamId: null, assigneeId: w.alex1.id });
    expect(by("tagged with another team, assigned to a member")).toMatchObject({ teamId: otherTeam, assigneeId: w.bob.id });
    expect(teams.find((t) => t.id === w.teamP1)?.members.map((m) => m.userId)).toEqual([w.bob.id]);
    expect(teams.find((t) => t.id === otherTeam)?.members).toEqual([]);
  });

  it("the filter bar (query language off) reads a team as its tagged work plus its people's untagged work", () => {
    expect(filterBarShows(w.teamP1)).toEqual(PLATFORM);
    expect(filterBarShows(otherTeam)).toEqual(["tagged with another team, assigned to a member"]);
  });

  it("picking the team in the query bar shows the same items", async () => {
    const { shows } = await boardShows({ cql: "team = Platform" });
    expect(shows).toEqual(PLATFORM);
    expect(shows).toEqual(filterBarShows(w.teamP1));
  }, 30_000);

  it("the other team keeps the item tagged with it, though its assignee is on Platform", async () => {
    const { shows } = await boardShows({ cql: `team = "Mobile ${w.stamp}"` });
    expect(shows).toEqual(["tagged with another team, assigned to a member"]);
    expect(shows).toEqual(filterBarShows(otherTeam));
  }, 30_000);

  it("a board saved with the team as its scope shows the same items, and its scope line says so", async () => {
    const config = {
      query: {
        v: CQL_VERSION,
        where: { op: "cmp", field: { kind: "sys", id: "team" }, cmp: "eq", value: { t: "ref", entity: "team", id: w.teamP1, label: "Platform" } },
      },
    };
    const { shows, scopeLine } = await boardShows({ config });
    expect(scopeLine).toBe("team = Platform");
    expect(shows).toEqual(PLATFORM);
  }, 30_000);

  it("`team IS EMPTY` is everything no team claims, the swimlanes' \"No team\"", async () => {
    const { shows } = await boardShows({ cql: "team IS EMPTY" });
    expect(shows).toContain("untagged, assigned to a non-member");
    for (const t of [...PLATFORM, "tagged with another team, assigned to a member"]) expect(shows).not.toContain(t);
  }, 30_000);
});
