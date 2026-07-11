// @vitest-environment jsdom
// COSMOS-51 — "Assigned to me" quick-filter on board views. The Backlog view
// was the one primary work-item board without it (Kanban/Scrum/Roadmap/Timeline
// get it from the shared FilterBar). This locks two pieces:
//   1. `isAssignedTo` — the pure predicate (primary assignee OR any co-assignee),
//      matching the Kanban filter so "me" behaves the same everywhere.
//   2. The Backlog view actually filters down to the current user when the
//      toggle is pressed, and restores the full list when pressed again —
//      combining with the existing "Hide done" filter.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- base-ui / dnd-kit need these in jsdom (see memory: testing-base-ui-in-jsdom) ---
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

// Keep the render light — these pull in heavy trees we don't exercise here.
vi.mock("@/components/boards/shared/create-issue-button", () => ({
  CreateIssueButton: () => <button type="button">New issue</button>,
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));
// The realtime hook opens an SSE EventSource (leader-tab), which jsdom lacks —
// and it's orthogonal to filtering, so stub it out for a deterministic render.
vi.mock("@/hooks/use-work-item-realtime", () => ({
  useWorkItemRealtime: () => {},
}));

const BOARD = {
  id: "b1",
  columns: [
    { id: "c1", key: "todo", name: "To Do", sortOrder: 0, category: "TODO" },
    { id: "c2", key: "done", name: "Done", sortOrder: 1, category: "DONE" },
  ],
};

const item = (
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  ticketNumber: Number(id.replace(/\D/g, "")) || 1,
  title,
  columnKey: "todo",
  priority: "MEDIUM" as const,
  assigneeId: null,
  cycleId: null,
  sortOrder: 0,
  ...extra,
});

const ITEMS = [
  item("w1", "My own task", { assigneeId: "me", sortOrder: 0 }),
  item("w2", "Someone else's task", { assigneeId: "other", sortOrder: 1 }),
  // Assigned to "other" as primary but co-assigned to me → still mine.
  item("w3", "My co-assigned task", {
    assigneeId: "other",
    assignees: [{ userId: "me" }],
    sortOrder: 2,
  }),
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

import { BacklogView, isAssignedTo } from "./backlog-view";
import type { WorkItem } from "@/types/models";

const asItem = (o: Record<string, unknown>) => o as unknown as WorkItem;

describe("isAssignedTo", () => {
  it("matches the primary assignee", () => {
    expect(isAssignedTo(asItem({ assigneeId: "me" }), "me")).toBe(true);
    expect(isAssignedTo(asItem({ assigneeId: "other" }), "me")).toBe(false);
  });

  it("matches any member of the multi-assignee set", () => {
    expect(
      isAssignedTo(asItem({ assigneeId: "other", assignees: [{ userId: "me" }] }), "me"),
    ).toBe(true);
  });

  it("is false for an unassigned item", () => {
    expect(isAssignedTo(asItem({ assigneeId: null }), "me")).toBe(false);
    expect(isAssignedTo(asItem({ assigneeId: null, assignees: [] }), "me")).toBe(false);
  });
});

const renderBacklog = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BacklogView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};

describe("BacklogView — Assigned to me", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("filters to the current user and restores when toggled off", async () => {
    renderBacklog();

    // Everything visible up front.
    await screen.findByText("My own task");
    expect(screen.getByText("Someone else's task")).toBeInTheDocument();
    expect(screen.getByText("My co-assigned task")).toBeInTheDocument();

    // The button only appears once /api/v1/me resolves.
    const btn = await screen.findByRole("button", { name: /assigned to me/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");

    // Filter down to me: keeps my primary + co-assigned, drops the other.
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("My own task")).toBeInTheDocument();
    expect(screen.getByText("My co-assigned task")).toBeInTheDocument();
    expect(screen.queryByText("Someone else's task")).toBeNull();

    // Toggle off → the full list comes back (AC: clear restores the view).
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Someone else's task")).toBeInTheDocument();
  });
});
