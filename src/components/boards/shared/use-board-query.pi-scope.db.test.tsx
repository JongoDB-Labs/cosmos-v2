// @vitest-environment jsdom
//
// (e2e DB) A sprint board with the query language on, scoped to a Program
// Increment, shows the work in that PI: what is planned into one of its
// sprints AND what is planned into the PI itself. Both happen in real
// projects, so both are seeded here.
//
// The board used to send `sprint = <PI>`, and `sprint` matches only the
// interval it names: the PI's own items showed and its sprints' items did not,
// so the PI view and a sprint view of the same PI had nothing in common.
//
// This drives the real hook. Its two requests (`cql/predicate`, and the
// ids-only fallback for rows the browser can't decide) are answered by the
// same server functions the routes call, against this database, so the
// compiler, the scope envelope and the in-browser interpreter are all real.
// The legacy filter bar (query language off) is run over the same rows and
// must agree.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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
import { intervalChildrenById } from "@/lib/intervals/interval-tree";
import type { Interval, WorkItem } from "@/types/models";
import { useBoardQuery } from "./use-board-query";

const SCHEMA = { version: 1, fields: FIELDS.map((f) => ({ ...f, sortable: !!f.sortable, groupable: !!f.groupable })), customFields: [], functions: FUNCTIONS };

describe("a board scoped to a Program Increment (e2e DB)", () => {
  let w: World;
  let pi: Interval;
  let sprintA: Interval;
  let sprintB: Interval;
  let nested: Interval;
  const item: Record<string, string> = {};
  /** The project's items as the board's own fetch delivers them. */
  let rows: Record<string, unknown>[];
  /** The project's intervals as the board's own fetch delivers them. */
  let intervals: Interval[];
  let inflight = 0;

  beforeAll(async () => {
    w = await seedWorld();
    const mkInterval = (number: number, name: string, extra: Record<string, unknown> = {}) =>
      prisma.interval.create({
        data: {
          orgId: w.orgA, projectId: w.P1.id, number, name, status: "ACTIVE",
          startDate: new Date("2026-10-01"), endDate: new Date("2026-12-24"), ...extra,
        },
      });
    // Numbers clear of the fixture's 1–3, which are unique per project.
    const piRow = await mkInterval(901, "PI 9", { intervalKind: "PROGRAM_INCREMENT" });
    const aRow = await mkInterval(902, "PI 9 Sprint A", { parentId: piRow.id });
    const bRow = await mkInterval(903, "PI 9 Sprint B", { parentId: piRow.id, status: "PLANNED" });
    const mkItem = async (title: string, ticketNumber: number, intervalId: string) => {
      const row = await prisma.workItem.create({
        data: {
          orgId: w.orgA, projectId: w.P1.id, ticketNumber, title, description: "", columnKey: "todo",
          workItemTypeId: w.typeTask, createdById: w.actor.id, intervalId,
        },
      });
      item[title] = row.id;
    };
    await mkItem("planned into the PI itself", 801, piRow.id);
    await mkItem("in sprint A", 802, aRow.id);
    await mkItem("in sprint B", 803, bRow.id);
    // Older data can hold a PI inside a PI; every writer refuses one now. The
    // interval tree lists it as a PI of its own, so the PI above it must not
    // take its work on either path.
    const nestedRow = await mkInterval(904, "PI 9 nested PI", { intervalKind: "PROGRAM_INCREMENT", parentId: piRow.id });
    const nestedSprintRow = await mkInterval(905, "nested PI sprint", { parentId: nestedRow.id, status: "PLANNED" });
    await mkItem("planned into a PI nested inside it", 804, nestedRow.id);
    await mkItem("in a sprint of the nested PI", 805, nestedSprintRow.id);

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
    intervals = JSON.parse(JSON.stringify(await prisma.interval.findMany({ where: { projectId: w.P1.id } })));
    pi = intervals.find((i) => i.id === piRow.id)!;
    sprintA = intervals.find((i) => i.id === aRow.id)!;
    sprintB = intervals.find((i) => i.id === bRow.id)!;
    nested = intervals.find((i) => i.id === nestedRow.id)!;

    // The board's requests, answered by what the routes run.
    vi.mocked(jsonFetch).mockImplementation((async (url: string, init?: RequestInit) => {
      if (url.endsWith("/query-language")) return { enabled: true, canManage: false };
      if (url.endsWith("/cql/schema")) return SCHEMA;
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
  afterEach(cleanup);

  const titleOf = (id: string) => (rows.find((r) => r.id === id)?.title as string) ?? id;
  const titles = (ids: Iterable<string>) => [...ids].map(titleOf).sort();

  /** What the board shows with the query language on and `iv` selected. */
  async function boardShows(iv: Interval): Promise<string[]> {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(
      () => useBoardQuery({ orgId: w.orgA, projectId: w.P1.id, sprint: { id: iv.id, name: iv.name, kind: iv.intervalKind }, rows }),
      { wrapper },
    );
    const asked = () => vi.mocked(jsonFetch).mock.calls.filter(([u]) => String(u).endsWith("/cql/predicate")).length;
    const before = asked();
    // Settled: the predicate has been asked for and answered, and so has the
    // ids fallback if any row needed it.
    await waitFor(
      () => {
        expect(asked()).toBeGreaterThan(before);
        expect(inflight).toBe(0);
        expect(result.current.pending).toBe(false);
      },
      { timeout: 15_000 },
    );
    return titles(rows.filter((r) => result.current.keep(r as { id: string })).map((r) => r.id as string));
  }

  /** What the board shows with the query language off: the filter bar's interval clause. */
  function filterBarShows(iv: Interval): string[] {
    const children = intervalChildrenById(intervals);
    const f = { ...emptyFilters, intervalId: iv.id };
    return titles(
      rows
        .filter((r) => matchesFilters(r as unknown as WorkItem, f, [], new Map(), new Date(), { intervalChildren: children }))
        .map((r) => r.id as string),
    );
  }

  const IN_PI = ["in sprint A", "in sprint B", "planned into the PI itself"];

  it("the fixture is what the cases below need", () => {
    // Every seeded row is on the board's list, including ones that must be
    // left out (another sprint, no sprint), so leaving them out means something.
    for (const id of Object.values(item)) expect(rows.some((r) => r.id === id)).toBe(true);
    expect(rows.some((r) => r.intervalId === w.sprintP1Active)).toBe(true);
    expect(rows.some((r) => r.intervalId === null)).toBe(true);
    expect(sprintA.parentId).toBe(pi.id);
    expect(pi.intervalKind).toBe("PROGRAM_INCREMENT");
  });

  it("selecting the PI shows its sprints' work and the work planned into the PI itself", async () => {
    expect(await boardShows(pi)).toEqual(IN_PI);
  }, 30_000);

  it("selecting one of its sprints still shows only that sprint", async () => {
    expect(await boardShows(sprintA)).toEqual(["in sprint A"]);
    expect(await boardShows(sprintB)).toEqual(["in sprint B"]);
  }, 30_000);

  it("the PI view contains every sprint view under it", async () => {
    const whole = new Set(await boardShows(pi));
    for (const s of [sprintA, sprintB]) for (const t of await boardShows(s)) expect(whole.has(t)).toBe(true);
  }, 30_000);

  it("a PI inside the PI (older data) is a PI of its own: both paths leave its work out of the outer one", async () => {
    expect(nested.parentId).toBe(pi.id);
    expect(nested.intervalKind).toBe("PROGRAM_INCREMENT");
    const outer = await boardShows(pi);
    expect(outer).toEqual(IN_PI);
    expect(outer).toEqual(filterBarShows(pi));
    // The positive control: the nested PI's own view has its work, on both paths.
    const NESTED = ["in a sprint of the nested PI", "planned into a PI nested inside it"];
    expect(filterBarShows(nested)).toEqual(NESTED);
    expect(await boardShows(nested)).toEqual(NESTED);
  }, 30_000);

  it("with the query language off the filter bar means the same thing", async () => {
    expect(filterBarShows(pi)).toEqual(IN_PI);
    expect(filterBarShows(sprintA)).toEqual(["in sprint A"]);
    expect(await boardShows(pi)).toEqual(filterBarShows(pi));
  }, 30_000);
});
