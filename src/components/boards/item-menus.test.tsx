// @vitest-environment jsdom
//
// COSMOS-211/212: the calendar and the roadmap had no item menu at all. Each now
// offers the shared, permission-gated one (the Gantt's is covered in
// timeline-view.test.tsx), and a change made from it shows without a reload.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => <button type="button">New issue</button>,
}));
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/boards/shared/filter-bar")>();
  return { ...actual, FilterBar: () => null };
});
vi.mock("@/components/work-items/board-item-detail-sheet", () => ({
  BoardItemDetailSheet: () => null,
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));

// Calendar entries land on their due date, so date them inside the month the
// calendar opens on.
const today = new Date();
const thisMonth = (day: number) =>
  new Date(today.getFullYear(), today.getMonth(), day, 12).toISOString();

const base = {
  orgId: "o1",
  projectId: "p1",
  columnKey: "todo",
  priority: "MEDIUM",
  assigneeId: null,
  assignees: [],
  highlight: null,
  archivedAt: null,
  completedAt: null,
  intervalId: null,
  tags: [],
  sortOrder: 0,
  children: [],
};
const ITEMS = [
  {
    ...base,
    id: "e1",
    ticketNumber: 1,
    title: "Payments epic",
    parentId: null,
    dueDate: null,
    startDate: null,
    workItemType: { key: "EPIC", name: "Epic" },
  },
  {
    ...base,
    id: "f1",
    ticketNumber: 2,
    title: "Card refunds",
    parentId: "e1",
    dueDate: thisMonth(10),
    startDate: null,
    workItemType: { key: "FEATURE", name: "Feature" },
  },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, init?: { method?: string }) => {
    if (init?.method) return Promise.resolve(null);
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.includes("/boards/")) return Promise.resolve({ id: "b1", columns: [] });
    return Promise.resolve([]);
  }),
}));

const { perms } = vi.hoisted(() => ({ perms: { mask: 0n } }));
vi.mock("@/components/providers/permissions-provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...real,
    usePermissions: () => ({
      orgId: "o1", orgSlug: "acme", role: "MEMBER", permissions: perms.mask,
      can: (p: bigint) => (perms.mask & p) === p,
    }),
  };
});

import { CalendarView } from "./calendar/calendar-view";
import { RoadmapView } from "./roadmap/roadmap-view";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { Permission } from "@/lib/rbac/permissions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const READ = Permission.ITEM_READ;
const EDIT = Permission.ITEM_READ | Permission.ITEM_UPDATE | Permission.ITEM_DELETE;

const VIEWS = {
  calendar: CalendarView,
  roadmap: RoadmapView,
} as const;

function renderView(name: keyof typeof VIEWS) {
  const View = VIEWS[name];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <View orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
}

const labels = async () =>
  within(await screen.findByRole("menu"))
    .getAllByRole("menuitem")
    .map((el) => el.textContent?.trim() ?? "");

const itemFetches = () =>
  vi.mocked(jsonFetch).mock.calls.filter(
    ([url, init]) => String(url).endsWith("/work-items") && !(init as RequestInit | undefined)?.method,
  ).length;

describe.each(Object.keys(VIEWS) as (keyof typeof VIEWS)[])("%s: the item menu", (name) => {
  it("right-click gives a viewer Open and Copy link only", async () => {
    perms.mask = READ;
    renderView(name);
    fireEvent.contextMenu(await screen.findByText("Card refunds"));
    expect(await labels()).toEqual(["Open", "Copy link"]);
  });

  it("the item's ⋯ button opens the same menu", async () => {
    perms.mask = READ;
    renderView(name);
    await screen.findByText("Card refunds");
    fireEvent.click(screen.getByRole("button", { name: "Actions for FSC-2" }));
    expect(await labels()).toEqual(["Open", "Copy link"]);
  });

  it("an editor's Archive saves, and the view refetches its items", async () => {
    perms.mask = EDIT;
    renderView(name);
    fireEvent.contextMenu(await screen.findByText("Card refunds"));
    expect(await labels()).toEqual(
      expect.arrayContaining(["Open", "Copy link", "Archive", "Delete"]),
    );
    const before = itemFetches();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(
        "/api/v1/orgs/o1/projects/p1/work-items/f1",
        expect.objectContaining({ method: "PUT", body: expect.stringContaining('"archivedAt":"') }),
      ),
    );
    await waitFor(() => expect(itemFetches()).toBeGreaterThan(before));
  });
});

describe("roadmap: the epic's lane header has the menu too", () => {
  it("right-clicking the epic opens its menu", async () => {
    perms.mask = READ;
    renderView("roadmap");
    fireEvent.contextMenu(await screen.findByText("Payments epic"));
    expect(await labels()).toEqual(["Open", "Copy link"]);
    expect(screen.getByRole("button", { name: "Actions for FSC-1" })).toBeTruthy();
  });
});

describe("calendar: an entry's menu wins over the day's New issue", () => {
  it("right-clicking an entry opens only the item's menu; empty day space still creates", async () => {
    perms.mask = EDIT | Permission.ITEM_CREATE;
    renderView("calendar");
    const entry = await screen.findByText("Card refunds");
    fireEvent.contextMenu(entry);
    const rows = await labels();
    expect(rows).toContain("Open");
    expect(rows.some((r) => r.startsWith("New issue"))).toBe(false);
    expect(screen.getAllByRole("menu")).toHaveLength(1);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.contextMenu(entry.closest("[data-board-date]")!);
    expect(await labels()).toEqual([expect.stringMatching(/^New issue on /)]);
  });
});

describe("calendar: the expanded day lists entries with the same menu", () => {
  it("right-clicking an entry in the day panel opens its menu", async () => {
    perms.mask = READ;
    renderView("calendar");
    await screen.findByText("Card refunds");
    fireEvent.click(screen.getByRole("button", { name: "1 item" }));
    // Now listed twice: in the day cell and in the panel below the grid.
    const [, inPanel] = await screen.findAllByText("Card refunds");
    fireEvent.contextMenu(inPanel);
    expect(await labels()).toEqual(["Open", "Copy link"]);
    expect(screen.getAllByRole("button", { name: "Actions for FSC-2" })).toHaveLength(2);
  });
});
