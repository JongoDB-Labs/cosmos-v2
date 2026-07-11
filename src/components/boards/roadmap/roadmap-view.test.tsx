// @vitest-environment jsdom
// COSMOS-51 — "Assigned to me" quick-filter on the Roadmap view. The Roadmap
// (epic swimlanes × increments) had no way to narrow to the current user. This
// locks that the toggle filters the feature cards down to mine and restores the
// full roadmap when pressed again.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));

// The detail sheet pulls in a heavy tree that's orthogonal to filtering.
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));

const BOARD = { id: "b1", columns: [] };

const EPIC = {
  id: "e1",
  ticketNumber: 1,
  title: "Epic One",
  workItemType: { key: "software.epic", name: "Epic" },
  parentId: null,
  cycleId: null,
  assigneeId: null,
  sortOrder: 0,
};

const ITEMS = [
  EPIC,
  {
    id: "f1",
    ticketNumber: 2,
    title: "My feature",
    workItemType: { key: "software.feature", name: "Feature" },
    parentId: "e1",
    cycleId: null,
    assigneeId: "me",
    sortOrder: 0,
  },
  {
    id: "f2",
    ticketNumber: 3,
    title: "Their feature",
    workItemType: { key: "software.feature", name: "Feature" },
    parentId: "e1",
    cycleId: null,
    assigneeId: "other",
    sortOrder: 1,
  },
];

const MEMBERS = [
  { userId: "me", user: { displayName: "Me" } },
  { userId: "other", user: { displayName: "Other" } },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url === "/api/v1/me")
      return Promise.resolve({ id: "me", email: "me@x.com", displayName: "Me" });
    if (url.endsWith("/boards/b1")) return Promise.resolve(BOARD);
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve(MEMBERS);
    if (url.endsWith("/cycles")) return Promise.resolve([]);
    return Promise.resolve([]);
  }),
}));

import { RoadmapView } from "./roadmap-view";

const renderRoadmap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoadmapView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};

describe("RoadmapView — Assigned to me", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("filters feature cards to the current user and restores when toggled off", async () => {
    renderRoadmap();

    // Both features visible up front, under their epic lane.
    await screen.findByText("My feature");
    expect(screen.getByText("Their feature")).toBeInTheDocument();
    expect(screen.getByText("Epic One")).toBeInTheDocument();

    const btn = await screen.findByRole("button", { name: /assigned to me/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");

    // Filter → only my feature (its epic lane stays for context).
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("My feature")).toBeInTheDocument();
    expect(screen.getByText("Epic One")).toBeInTheDocument();
    expect(screen.queryByText("Their feature")).toBeNull();

    // Toggle off → the full roadmap comes back.
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Their feature")).toBeInTheDocument();
  });
});
