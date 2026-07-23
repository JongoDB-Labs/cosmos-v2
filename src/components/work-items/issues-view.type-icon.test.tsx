// @vitest-environment jsdom
// COSMOS-90 — regression: the Issues list rendered a work-item type's `icon`
// (a lucide name, e.g. "BookOpen") as raw text next to the type name, so a row
// read "BookOpen Story" instead of showing the SVG glyph. This locks the Type
// cell to render an <svg> and never leak the icon name as visible text.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- base-ui needs these in jsdom (see memory: testing-base-ui-in-jsdom) ---
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => "/acme/issues",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/hooks/use-work-item-realtime", () => ({ useWorkItemRealtime: () => {} }));
vi.mock("@/components/work-items/saved-views-picker", () => ({ SavedViewsPicker: () => null }));
vi.mock("@/components/work-items/save-as-board-dialog", () => ({ SaveAsBoardDialog: () => null }));
vi.mock("@/components/work-items/create-work-item-dialog", () => ({ CreateWorkItemDialog: () => null }));
vi.mock("@/components/work-items/issue-detail-sheet", () => ({ IssueDetailSheet: () => null }));
vi.mock("@/components/providers/permissions-provider", async (importActual) => {
  const actual =
    await importActual<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...actual,
    usePermissions: () => ({
      orgId: "o1",
      orgSlug: "acme",
      role: "ADMIN",
      permissions: 0n,
      can: () => true,
    }),
  };
});
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { IssuesView } from "./issues-view";
import { jsonFetch } from "@/lib/query/json-fetcher";

const STORY_TYPE = { id: "t1", key: "software.story", name: "Story", icon: "BookOpen", color: "#22c55e" };

const FACETS = {
  projects: [{ id: "p1", key: "ENG", name: "Engineering", archived: false }],
  types: [STORY_TYPE],
  statuses: [{ key: "todo", name: "To Do", category: "TODO" }],
  statusesByProject: { p1: [{ key: "todo", name: "To Do", category: "TODO" }] },
  members: [],
  labels: [],
  cycles: [],
  managedProjectIds: [],
};

const ROW = {
  id: "w1",
  ticketNumber: 1,
  ticketKey: "ENG-1",
  title: "Wire up the widget",
  columnKey: "todo",
  priority: "MEDIUM" as const,
  type: STORY_TYPE,
  project: { id: "p1", key: "ENG", name: "Engineering" },
  assignee: null,
  assignees: [],
  parent: null,
  cycleId: null,
  storyPoints: null,
  tags: [],
  startDate: null,
  dueDate: null,
  completedAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(jsonFetch).mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/work-items/facets")) return Promise.resolve(FACETS);
    if (url.includes("/work-items/search")) return Promise.resolve({ data: [ROW], total: 1 });
    if (url.includes("/saved-views")) return Promise.resolve([]);
    return Promise.resolve({});
  });
});
afterEach(cleanup);

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <IssuesView orgId="o1" orgSlug="acme" />
    </QueryClientProvider>,
  );
}

describe("IssuesView — type icon renders as SVG (COSMOS-90)", () => {
  it("shows the type's SVG glyph and never the raw icon name as text", async () => {
    const { container } = renderView();
    await screen.findByText("ENG-1");

    // The type name still shows…
    await waitFor(() => expect(screen.getByText("Story")).toBeInTheDocument());
    // …as an actual SVG glyph, not the literal lucide name.
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByText("BookOpen")).not.toBeInTheDocument();
    expect(screen.queryByText(/BookOpen/)).not.toBeInTheDocument();
  });
});
