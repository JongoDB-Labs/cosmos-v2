// @vitest-environment jsdom
//
// A sprint board with the query language on, scoped to a Program Increment
// (the PI's name in the sprint row), asks for `pi = …`: the PI and every sprint
// inside it. It used to send `sprint = <PI>`, which matches only the PI's own
// work, so the PI view and its sprints' views had nothing in common.
//
// What this pins is the WIRING: the Kanban is the one board that hands an
// interval to the board query, so the interval's kind has to travel with it,
// and nothing may be asked before the kind is known. What `pi` matches is
// proven against a database in use-board-query.pi-scope.db.test.tsx.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FIELDS } from "@/lib/query/fields";
import { FUNCTIONS } from "@/lib/query/functions";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!("EventSource" in globalThis)) {
  globalThis.EventSource = class {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  } as unknown as typeof EventSource;
}

vi.mock("@/components/providers/permissions-provider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "ADMIN", permissions: 0n, can: () => true }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/P1/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { KanbanBoard } from "./kanban-board";

const PI = "11111111-1111-4111-8111-111111111111";
const SPRINT = "22222222-2222-4222-8222-222222222222";
const interval = (id: string, name: string, intervalKind: string, parentId: string | null, number: number) => ({
  id, orgId: "o1", projectId: "p1", intervalKind, number, name, goal: "", status: "ACTIVE",
  startDate: "2026-10-01T00:00:00.000Z", endDate: "2026-12-24T00:00:00.000Z", parentId, report: null,
});
const INTERVALS = [interval(PI, "PI 9", "PROGRAM_INCREMENT", null, 9), interval(SPRINT, "PI 9 Sprint A", "SPRINT", PI, 10)];

const SCHEMA = { version: 1, fields: FIELDS.map((f) => ({ ...f, sortable: !!f.sortable, groupable: !!f.groupable })), customFields: [], functions: FUNCTIONS };

/** Answers like the server. `/intervals` waits for `release()` when held. */
function installFetch(opts: { holdIntervals?: boolean } = {}) {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      let body: unknown = [];
      if (url.endsWith("/boards/b1")) body = { id: "b1", name: "Sprint board", type: "SCRUM", config: {}, columns: [{ id: "c1", key: "todo", name: "To do", sortOrder: 0, category: "TODO" }] };
      else if (url.endsWith("/query-language")) body = { enabled: true, canManage: false };
      else if (url.endsWith("/cql/schema")) body = SCHEMA;
      else if (url.endsWith("/cql/validate")) body = { valid: true, diagnostics: [] };
      else if (url.endsWith("/cql/predicate")) body = { where: {} };
      else if (url.endsWith("/intervals")) {
        if (opts.holdIntervals) await held;
        body = INTERVALS;
      }
      return new Response(JSON.stringify({ data: body }), { status: 200 });
    }),
  );
  return { release };
}

const predicateQueries = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([u]) => String(u).endsWith("/cql/predicate"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)).query);

/** Every (field, interval id) pair a query names. */
function intervalClauses(q: unknown): string[] {
  const n = q as { where?: unknown; args?: unknown[]; field?: { id: string }; value?: { entity?: string; id?: string } };
  if (n?.where !== undefined) return intervalClauses(n.where);
  if (n?.args) return n.args.flatMap(intervalClauses);
  return n?.value?.entity === "interval" ? [`${n.field?.id} ${n.value.id}`] : [];
}

function renderKanban(initialIntervalId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KanbanBoard orgId="o1" projectId="p1" projectKey="P1" boardId="b1" initialIntervalId={initialIntervalId} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KanbanBoard — a Program Increment scope with the query language on", () => {
  it("asks for `pi = <PI>` and says so in the scope line", async () => {
    installFetch();
    renderKanban(PI);
    expect(await screen.findByText('pi = "PI 9"')).toBeTruthy();
    await waitFor(() => expect(predicateQueries().length).toBeGreaterThan(0));
    for (const q of predicateQueries()) expect(intervalClauses(q)).toEqual([`pi ${PI}`]);
  });

  it("a sprint is still `sprint = <sprint>`", async () => {
    installFetch();
    renderKanban(SPRINT);
    expect(await screen.findByText('sprint = "PI 9 Sprint A"')).toBeTruthy();
    await waitFor(() => expect(predicateQueries().length).toBeGreaterThan(0));
    for (const q of predicateQueries()) expect(intervalClauses(q)).toEqual([`sprint ${SPRINT}`]);
  });

  it("asks nothing until the intervals say what kind the selection is", async () => {
    const { release } = installFetch({ holdIntervals: true });
    renderKanban(PI);
    // The board itself has loaded (its column is up) while the intervals are held.
    expect(await screen.findByText("To do")).toBeTruthy();
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith("/cql/schema"))).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(predicateQueries()).toHaveLength(0);
    // No guessed `sprint = <PI>` on the scope line either.
    expect(screen.queryByText(/This board shows/)).toBeNull();

    release();
    await waitFor(() => expect(predicateQueries().length).toBeGreaterThan(0));
    for (const q of predicateQueries()) expect(intervalClauses(q)).toEqual([`pi ${PI}`]);
  });
});
