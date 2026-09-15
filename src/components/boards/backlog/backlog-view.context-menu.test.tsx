// @vitest-environment jsdom
//
// The backlog row's right-click menu covered nothing.
//
// `<ActionMenu>` wrapped only `<span className="sr-only">Row actions for …
// </span>`. `sr-only` is a clipped 1x1px box, so the `onContextMenu` handler
// ActionMenu puts on its wrapper had no area over the ticket key, the title,
// the priority badge or the avatar — right-clicking the row did nothing, and
// the only way to the menu was the hover-revealed ⋯ button.
//
// Every other work-item surface gives you the whole row or card: Kanban and
// RAID wrap the card, and DataTable puts `onContextMenu` on the `<tr>`. The
// backlog was the outlier.
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
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => <button type="button">New issue</button>,
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));
vi.mock("@/hooks/use-work-item-realtime", () => ({ useWorkItemRealtime: () => {} }));

const BOARD = {
  id: "b1",
  columns: [
    { id: "c1", key: "todo", name: "To Do", sortOrder: 0, category: "TODO" },
    { id: "c2", key: "done", name: "Done", sortOrder: 1, category: "DONE" },
  ],
};
const ITEMS = [
  {
    id: "w1",
    ticketNumber: 7,
    title: "Rewire the telemetry",
    columnKey: "todo",
    priority: "MEDIUM" as const,
    assigneeId: null,
    intervalId: null,
    sortOrder: 0,
  },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url === "/api/v1/me")
      return Promise.resolve({ id: "me", email: "me@x.com", displayName: "Me" });
    if (url.endsWith("/boards/b1")) return Promise.resolve(BOARD);
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve([]);
    // One interval, so "Move to sprint" has a target and the menu is non-empty.
    // ActionMenu renders NOTHING when every group is empty, which would make
    // this whole test vacuous.
    if (url.endsWith("/intervals"))
      return Promise.resolve([
        { id: "s1", name: "Sprint 1", status: "ACTIVE", intervalKind: "SPRINT" },
      ]);
    return Promise.resolve([]);
  }),
}));

import { BacklogView } from "./backlog-view";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderBacklog = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BacklogView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );

/**
 * ActionMenu's right-click region is the `display: contents` div that holds its
 * children and its ⋯ trigger. Whatever that div contains is right-clickable;
 * whatever it does not, is not. So "is the row right-clickable" is exactly "does
 * that div contain the row's cells".
 */
function contextMenuRegionAround(trigger: HTMLElement): HTMLElement {
  const region = trigger.parentElement;
  if (!region) throw new Error("the ⋯ trigger has no wrapper");
  return region;
}

describe("BacklogView — the row itself opens the actions menu", () => {
  it("puts the ticket key, title, badge and avatar inside the right-click region", async () => {
    renderBacklog();
    const title = await screen.findByText("Rewire the telemetry");
    const trigger = screen.getByRole("button", { name: /open menu/i });
    const region = contextMenuRegionAround(trigger);

    // The reported gap, stated as an assertion.
    expect(region.contains(title)).toBe(true);
    expect(region.textContent).toContain("FSC-7");
  });

  it("still renders the ⋯ trigger, for touch and for discoverability", async () => {
    // Right-click does not exist on a phone; the hover/tap affordance has to
    // survive the change that made the row itself clickable.
    renderBacklog();
    await screen.findByText("Rewire the telemetry");
    expect(screen.getByRole("button", { name: /open menu/i })).toBeInTheDocument();
  });

  it("keeps the row's own open-detail button working alongside the menu", async () => {
    // ActionMenu's wrapper is `display: contents`, so the cells stay direct flex
    // children and the title button is still a button, not swallowed by it.
    renderBacklog();
    const title = await screen.findByText("Rewire the telemetry");
    expect(title.closest("button")).not.toBeNull();
  });

  it("keeps the sr-only description, so the menu is announced", async () => {
    renderBacklog();
    await screen.findByText("Rewire the telemetry");
    expect(screen.getByText(/Row actions for Rewire the telemetry/)).toBeInTheDocument();
  });
});
