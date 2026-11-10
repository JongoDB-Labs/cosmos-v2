// @vitest-environment jsdom
// Where the create control sits, on the board Jon spends his time on.
//
// "New work item" led the Kanban toolbar (left edge, before the mode controls).
// Every other board that has one puts it on the right: Backlog, Table and RAID
// in an `ml-auto` group, Calendar on its month bar, Timeline after the lens and
// zoom groups. The Issues page does the same and ALREADY enforces it by test
// (work-items-view.save-as-board.test.tsx asserts actions follow the query bar).
// Kanban -- and therefore SCRUM, which wraps it -- was the one outlier, so the
// primary action moved depending on which board you were standing on.
//
// Right is also the convention outside this app, and it keeps the left edge of
// every band for identity and counts, which is what makes a column of bands
// scannable.
//
// The accessible name does not change, which matters: `e2e/fixtures/create-issue.ts`
// locates this button by the exact name "New work item" and that fixture backs
// journey-create-work-item and journey-work-item-drag.
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
if (!("EventSource" in globalThis)) {
  globalThis.EventSource = class {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  } as unknown as typeof EventSource;
}

vi.mock("@/components/providers/permissions-provider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermissions: () => ({
    orgId: "o1",
    orgSlug: "acme",
    role: "ADMIN",
    permissions: 0n,
    can: () => true,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/P1/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { KanbanBoard } from "./kanban-board";

const ITEM = {
  id: "i1",
  orgId: "o1",
  projectId: "p1",
  workItemTypeId: "t1",
  title: "Critical outage",
  description: "",
  columnKey: "todo",
  priority: "CRITICAL",
  assigneeId: null,
  assignees: [],
  parentId: null,
  intervalId: null,
  ticketNumber: 1,
  tags: [],
  customFields: {},
  archivedAt: null,
  startDate: null,
  dueDate: null,
  completedAt: null,
  storyPoints: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  workItemType: {
    id: "t1",
    key: "task",
    name: "Task",
    icon: null,
    color: null,
  },
};

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/boards/b1")
        ? {
            id: "b1",
            name: "Board",
            type: "KANBAN",
            config: {},
            columns: [
              {
                id: "c1",
                key: "todo",
                name: "To do",
                sortOrder: 0,
                category: "TODO",
              },
            ],
          }
        : url.endsWith("/work-items")
          ? [ITEM]
          : [];
      return new Response(JSON.stringify({ data: body }), { status: 200 });
    }),
  );
}

function renderKanban() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KanbanBoard orgId="o1" projectId="p1" projectKey="P1" boardId="b1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Kanban toolbar — the create control is on the right", () => {
  it("renders both the mode control and the create control", async () => {
    // Positive control: the ordering assertions below are meaningless if either
    // element is absent, and `getByRole` would then throw for the wrong reason.
    installFetch();
    renderKanban();
    expect(
      await screen.findByRole("button", { name: "New work item" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^select$/i })).toBeTruthy();
  });

  it("puts New work item after the mode controls in document order", async () => {
    installFetch();
    renderKanban();
    const newIssue = await screen.findByRole("button", { name: "New work item" });
    const select = screen.getByRole("button", { name: /^select$/i });
    expect(
      select.compareDocumentPosition(newIssue) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("right-aligns it, rather than merely ordering it last", async () => {
    // Order alone would still render it hard against "Select". The `ml-auto`
    // group is what actually pushes it to the band's right edge, and it is what
    // Backlog, Table and RAID use.
    installFetch();
    renderKanban();
    const newIssue = await screen.findByRole("button", { name: "New work item" });
    expect(newIssue.closest('[class*="ml-auto"]')).not.toBeNull();
  });

  it("keeps the exact accessible name the e2e fixture locates it by", async () => {
    installFetch();
    renderKanban();
    expect(
      await screen.findByRole("button", { name: "New work item" }),
    ).toBeTruthy();
  });
});
