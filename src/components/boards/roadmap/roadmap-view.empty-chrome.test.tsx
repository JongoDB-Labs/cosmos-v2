// @vitest-environment jsdom
// The Roadmap's zero-rows branch already kept the filter bar, and its comment
// says why: "filtering can now EMPTY this board, and hiding the control that
// did it strands the user on a blank screen with no way back."
//
// That argument was only ever applied to the filter bar. The branch still
// dropped the toolbar -- and "Hide done" lives in the toolbar. So on a roadmap
// where every epic is done, turning Hide-done on empties the board, which
// removes the toolbar, which removes the Hide-done checkbox: the exact dead end
// the existing comment set out to prevent, one control over.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));
// Stubbed to keep the filter surface's control tree out of this test, but it
// now HOSTS the board's actions (one band instead of two identical ones --
// ffe324aa). A stub returning null swallows them, and the test then goes green
// while blind to controls it may be exercising. `never` rather than ReactNode:
// the automatic JSX runtime does not put `React` in scope in a test file.
vi.mock("@/components/boards/shared/board-query-bar", () => ({
  BoardQueryBar: ({ actions }: { actions?: unknown }) => <>{actions as never}</>,
}));

/** What `/work-items` returns for a given test. */
let items: unknown[] = [];

const BOARD = {
  id: "b1",
  name: "Roadmap",
  columns: [
    { id: "c1", key: "todo", name: "To Do", sortOrder: 0, category: "TODO" },
    { id: "c2", key: "done", name: "Done", sortOrder: 1, category: "DONE" },
  ],
};

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url === "/api/v1/me")
      return Promise.resolve({
        id: "me",
        email: "me@x.com",
        displayName: "Me",
      });
    if (url.endsWith("/boards/b1")) return Promise.resolve(BOARD);
    if (url.endsWith("/work-items")) return Promise.resolve(items);
    return Promise.resolve([]);
  }),
}));

import { RoadmapView } from "./roadmap-view";

function renderRoadmap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoadmapView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
}

/** An epic with a feature under it -- the shape the roadmap actually lanes. */
const ONE_EPIC = [
  {
    id: "e1",
    ticketNumber: 1,
    title: "An epic that exists",
    columnKey: "todo",
    priority: "MEDIUM" as const,
    assigneeId: null,
    intervalId: null,
    sortOrder: 0,
    workItemType: { key: "EPIC", name: "Epic" },
  },
  {
    id: "w2",
    ticketNumber: 2,
    title: "A feature under it",
    columnKey: "todo",
    parentId: "e1",
    priority: "MEDIUM" as const,
    assigneeId: null,
    intervalId: null,
    sortOrder: 1,
  },
];

afterEach(() => {
  cleanup();
  items = [];
});

describe("Roadmap chrome does not depend on having rows", () => {
  it("keeps Hide done reachable on an empty roadmap", async () => {
    items = [];
    renderRoadmap();
    expect(await screen.findByText(/hide done/i)).toBeTruthy();
  });

  it("keeps Expand/Collapse all reachable on an empty roadmap", async () => {
    items = [];
    renderRoadmap();
    expect(await screen.findByText(/(expand|collapse) all/i)).toBeTruthy();
  });

  it("still says what to create when empty", async () => {
    // Information-preservation control: keeping the toolbar must not cost the
    // empty state's copy, which is the only place the Epic/Feature rule is said.
    items = [];
    renderRoadmap();
    expect(await screen.findByText(/no epics to roadmap yet/i)).toBeTruthy();
  });

  it("shows Hide done with rows too", async () => {
    // Positive control: the assertions above are about the empty branch, not
    // about the toolbar being absent everywhere.
    items = ONE_EPIC;
    renderRoadmap();
    expect(await screen.findByText(/hide done/i)).toBeTruthy();
    expect(screen.queryByText(/no epics to roadmap yet/i)).toBeNull();
  });
});
