// @vitest-environment jsdom
// The title button opens the item's sheet, and only that. It used to start the
// inline title edit while its click bubbled to the row and opened the sheet
// too, so closing the sheet left the row mid-edit (an <input> where the button
// had been) and keyboard focus with nowhere to return.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/P1/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

// Portal/observer-heavy children; none of them touch the grouping headers.
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => null,
}));
const sheet = vi.hoisted(() => ({ itemId: null as string | null }));
vi.mock("@/components/work-items/board-item-detail-sheet", () => ({
  BoardItemDetailSheet: ({ itemId }: { itemId: string | null }) => {
    sheet.itemId = itemId;
    return null;
  },
}));
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/boards/shared/filter-bar")>();
  return { ...actual, FilterBar: () => null };
});

const item = (
  n: number,
  type: { id: string; key: string; name: string },
  columnKey: string,
) => ({
  id: `i${n}`,
  ticketNumber: 100 + n,
  title: `Item ${n}`,
  columnKey,
  workItemTypeId: type.id,
  workItemType: type,
  priority: "MEDIUM",
  assigneeId: null,
  assignees: [],
  intervalId: null,
  storyPoints: null,
  dueDate: null,
  completedAt: null,
  archivedAt: null,
  highlight: null,
  sortOrder: n,
  tags: [],
});

const BUG = { id: "t-bug", key: "BUG", name: "Bug" };
const STORY = { id: "t-story", key: "STORY", name: "Story" };

const ITEMS = [
  item(1, BUG, "todo"),
  item(2, STORY, "todo"),
  item(3, BUG, "done"),
];

const BOARD = {
  id: "b1",
  config: {},
  columns: [
    { key: "todo", name: "To Do", category: "TODO", sortOrder: 0 },
    { key: "done", name: "Done", category: "DONE", sortOrder: 1 },
  ],
};

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve([]);
    if (url.endsWith("/intervals")) return Promise.resolve([]);
    if (url.endsWith("/boards")) return Promise.resolve([BOARD]);
    if (url.includes("/boards/")) return Promise.resolve(BOARD);
    return Promise.resolve([]);
  }),
}));

import { TableView } from "./table-view";

const renderTable = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TableView orgId="o1" projectId="p1" projectKey="P1" boardId="b1" />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  cleanup();
  sheet.itemId = null;
});

describe("TableView title button", () => {
  it("opens the item's sheet without starting an inline edit", async () => {
    renderTable();
    fireEvent.click(await screen.findByRole("button", { name: /Item 2/ }));
    expect(sheet.itemId).toBe("i2");
    // The title cell is still the button, not an edit box.
    expect(screen.queryByDisplayValue("Item 2")).toBeNull();
    expect(screen.getByRole("button", { name: /Item 2/ })).toBeTruthy();
  });
});
