// @vitest-environment jsdom
// "Group by: Type" on a TABLE board grouped nothing: the option's value was
// "type", but the column it must name is the accessor id `workItemTypeId`.
// TanStack silently ignores a grouping id that matches no column, so the table
// rendered as an ungrouped flat list and `getGroupLabel`'s workItemTypeId branch
// — which exists precisely to turn the type UUID into a name — never ran.
//
// The assertion is on what the user sees: a group header per type, labelled with
// the type NAME. That covers both halves at once; grouping by Status is kept as
// the control, so a harness that renders no headers at all cannot pass.
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
vi.mock("@/components/work-items/board-item-detail-sheet", () => ({
  BoardItemDetailSheet: () => null,
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

/** The toolbar's "Group by" <select> — the only one offering "No grouping". */
const groupBy = (container: HTMLElement, label: string) => {
  const select = Array.from(container.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.textContent === "No grouping"),
  );
  expect(select, "the Group by select is gone — update this test").toBeTruthy();
  const option = Array.from(select!.options).find((o) => o.textContent === label);
  expect(option, `no "${label}" grouping option`).toBeTruthy();
  fireEvent.change(select!, { target: { value: option!.value } });
};

/** Text of every group-header row the table drew (they span all columns). */
const groupHeaders = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("tbody tr > td[colspan]")).map(
    (td) => td.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );

afterEach(cleanup);

describe("TableView group-by", () => {
  it("groups by Type and labels each header with the type name", async () => {
    const { container } = renderTable();
    await screen.findByText("Item 1");

    groupBy(container, "Type");

    const headers = groupHeaders(container);
    expect(headers).toContain("Bug (2)");
    expect(headers).toContain("Story (1)");
    // Never the raw id — that is the "UUID instead of a name" regression.
    expect(headers.join(" ")).not.toContain("t-bug");
  });

  it("groups by Status, labelled with the column name", async () => {
    const { container } = renderTable();
    await screen.findByText("Item 1");

    groupBy(container, "Status");

    const headers = groupHeaders(container);
    expect(headers).toContain("To Do (2)");
    expect(headers).toContain("Done (1)");
  });
});
