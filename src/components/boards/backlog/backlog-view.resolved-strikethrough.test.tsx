// @vitest-environment jsdom
//
// BUG 635be41c — "cancelled/OBE should scratch out children like DONE does".
//
// `isWorkItemResolved` was written FOR this bug and says so in its own doc: it is for
// "the places that strike out a settled item". It then shipped with ONE call site, the
// card-detail children list, so every other surface kept striking on done-ness alone and
// a Cancelled/OBE row sat unstruck beside struck Done rows — dropped work reading as
// still outstanding. That is this repo's most-repeated defect shape: a correct rule
// nobody calls.
//
// The second describe below is the one that matters most. The fix must NOT widen the
// filter: "Hide done" means delivered, and hiding dropped work behind a control labelled
// "Hide done" would be a new bug. Striking out and hiding are different questions, and
// these specs pin them apart.
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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/boards/shared/new-work-item-button", () => ({
  NewWorkItemButton: () => <button type="button">New work item</button>,
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({ CardDetailSheet: () => null }));
vi.mock("@/hooks/use-work-item-realtime", () => ({ useWorkItemRealtime: () => {} }));

// A real Cancelled lane, with the seeded key and category — the thing the old predicate
// could not see.
const BOARD = {
  id: "b1",
  columns: [
    { id: "c1", key: "todo", name: "To Do", sortOrder: 0, category: "TODO" },
    { id: "c2", key: "done", name: "Done", sortOrder: 1, category: "DONE" },
    { id: "c3", key: "cancelled", name: "Cancelled", sortOrder: 2, category: "CANCELLED" },
  ],
};

const ITEMS = [
  { id: "w1", ticketNumber: 1, title: "Still open task", columnKey: "todo", priority: "MEDIUM", assigneeId: null, intervalId: null, sortOrder: 0 },
  { id: "w2", ticketNumber: 2, title: "Delivered task", columnKey: "done", priority: "MEDIUM", assigneeId: null, intervalId: null, sortOrder: 1 },
  { id: "w3", ticketNumber: 3, title: "Dropped task", columnKey: "cancelled", priority: "MEDIUM", assigneeId: null, intervalId: null, sortOrder: 2 },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url === "/api/v1/me") return Promise.resolve({ id: "me", email: "me@x.com", displayName: "Me" });
    if (url.endsWith("/boards/b1")) return Promise.resolve(BOARD);
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve([]);
    if (url.endsWith("/intervals")) return Promise.resolve([]);
    return Promise.resolve([]);
  }),
}));

import { BacklogView } from "./backlog-view";

const renderBacklog = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BacklogView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};

/** Is the row's TITLE struck through? Asserted on the element that actually carries it. */
const struck = (title: string) => screen.getByText(title).className.includes("line-through");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BacklogView — a settled row is struck out", () => {
  it("strikes a DONE row (the behaviour the report asked to match)", async () => {
    renderBacklog();
    await screen.findByText("Delivered task");
    expect(struck("Delivered task")).toBe(true);
  });

  it("strikes a CANCELLED row — the bug", async () => {
    renderBacklog();
    await screen.findByText("Dropped task");
    expect(struck("Dropped task")).toBe(true);
  });

  it("CONTROL: leaves an open row alone", async () => {
    // Without this, striking EVERYTHING would pass both specs above.
    renderBacklog();
    await screen.findByText("Still open task");
    expect(struck("Still open task")).toBe(false);
  });
});

describe("BacklogView — striking out is not hiding", () => {
  it("\"Hide done\" hides the delivered row and KEEPS the cancelled one", async () => {
    // The whole point of not widening `isDone`. A control labelled "Hide done" must mean
    // delivered: dropped work is still work someone needs to see and reopen or re-plan.
    renderBacklog();
    await screen.findByText("Delivered task");

    fireEvent.click(screen.getByText("Hide done"));

    expect(screen.queryByText("Delivered task")).toBeNull();
    expect(screen.getByText("Dropped task")).toBeTruthy();
    expect(screen.getByText("Still open task")).toBeTruthy();
    // ...and it is still struck through while visible.
    expect(struck("Dropped task")).toBe(true);
  });
});
