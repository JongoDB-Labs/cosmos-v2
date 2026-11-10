// @vitest-environment jsdom
// Feedback 36938fd0's sibling: a control that is missing exactly when you need
// it. The RAID log's zero-items branch was a separate early return that
// rendered the filter bar and the empty state but NOT the toolbar -- and the
// toolbar is where "New work item" lives. So the one screen whose entire message is
// "there is nothing here yet" was the one screen with no way to add anything.
//
// This is the shape recorded in feedback-a-how-do-i-question-is-a-placement-bug:
// the capability exists, the empty branch just doesn't render it, and the user
// reports it as missing rather than as misplaced. Roadmap had the same split
// (its empty branch dropped Hide-done and Collapse-all).
//
// The rule these cases pin: a board's chrome does not depend on whether the
// board has any rows.
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

vi.mock("@/components/boards/shared/new-work-item-button", () => ({
  NewWorkItemButton: () => (
    <button type="button" data-testid="new-work-item">
      New work item
    </button>
  ),
}));

/** What `/work-items` returns for a given test. */
let items: unknown[] = [];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(items);
    return Promise.resolve([]);
  }),
}));

import { RaidView } from "./raid-view";

function renderRaid() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RaidView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
}

const ONE_ITEM = [
  {
    id: "i1",
    ticketNumber: 1,
    title: "A real risk",
    tags: ["risk"],
    columnKey: "todo",
    priority: "MEDIUM" as const,
    assigneeId: null,
  },
];

afterEach(() => {
  cleanup();
  items = [];
});

describe("RAID log chrome does not depend on having rows", () => {
  it("offers New work item on an empty log", async () => {
    items = [];
    renderRaid();
    expect(await screen.findByTestId("new-work-item")).toBeTruthy();
  });

  it("still explains what the log is for when empty", async () => {
    items = [];
    renderRaid();
    // The information-preservation control: keeping the toolbar must not cost
    // the empty state's copy, which is the only place the tagging rule is said.
    expect(await screen.findByText(/no items to triage/i)).toBeTruthy();
    expect(screen.getByText(/tag a work item/i)).toBeTruthy();
  });

  it("offers Hide done on an empty log", async () => {
    items = [];
    renderRaid();
    expect(await screen.findByText(/hide done/i)).toBeTruthy();
  });

  it("offers New work item with rows too", async () => {
    // Positive control: proves the assertions above are about the empty branch
    // and not about the component failing to render a toolbar at all.
    items = ONE_ITEM;
    renderRaid();
    expect(await screen.findByTestId("new-work-item")).toBeTruthy();
    expect(screen.queryByText(/no items to triage/i)).toBeNull();
  });
});
