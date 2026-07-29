// @vitest-environment jsdom
//
// BR: the Activity page read "Steve changed interval to Unknown on <ticket>",
// when he had moved the item INTO a named sprint. The phrase is built from a
// generic field-change shape and `activityValueLabel` resolves id-valued fields
// through caller-supplied lookups — but this feed only wired `user` and `type`,
// so every `intervalId` change fell through to the unresolved-id fallback. The
// facets payload it already fetches carries the intervals, so the fix is to wire
// the lookup (and `column`, which had the same gap and printed the raw slug).
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/activity" }));

const FACETS = {
  projects: [{ id: "p1", key: "ENG", name: "Engineering", archived: false }],
  types: [{ id: "typ-1", key: "software.story", name: "Story" }],
  members: [{ id: "u1", displayName: "Dana Reyes" }],
  intervals: [{ id: "int-1", name: "Sprint 1" }],
  statuses: [{ key: "in_progress", name: "In Progress" }],
};

function row(over: Record<string, unknown>) {
  return {
    id: "a1",
    action: "updated",
    field: "intervalId",
    oldValue: null,
    newValue: "int-1",
    createdAt: new Date().toISOString(),
    actor: { id: "u1", displayName: "Dana Reyes", avatarUrl: null },
    item: {
      id: "w1",
      ticketKey: "ENG-46",
      ticketNumber: 46,
      title: "nimpt-rest",
      columnKey: "todo",
      project: { id: "p1", key: "ENG", name: "Engineering" },
      type: { id: "typ-1", name: "Story", icon: null, color: null },
    },
    ...over,
  };
}

let feedRows: unknown[] = [];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: (url: string) =>
    url.includes("/work-items/facets")
      ? Promise.resolve(FACETS)
      : Promise.resolve({ data: feedRows, nextCursor: null }),
}));

import { UpdatesFeed } from "@/components/work-items/updates-feed";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

function renderFeed() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <UpdatesFeed orgId="o1" orgSlug="acme" />
    </QueryClientProvider>,
  );
}

describe("UpdatesFeed — an interval change names the sprint (BR)", () => {
  it("renders the interval's NAME, not 'Unknown'", async () => {
    feedRows = [row({})];
    renderFeed();

    await waitFor(() => expect(screen.getByText("Sprint 1")).toBeTruthy());
    expect(screen.queryByText("Unknown")).toBeNull();
    // The whole phrase, so a passing lookup can't hide a broken sentence.
    expect(screen.getByText("changed", { exact: false }).textContent).toContain("interval");
  });

  it("names the old interval too when an item moves between sprints", async () => {
    feedRows = [
      row({
        oldValue: "int-1",
        newValue: "int-2",
        // A second interval the facets DO know about.
      }),
    ];
    FACETS.intervals.push({ id: "int-2", name: "Sprint 2" });
    renderFeed();

    await waitFor(() => expect(screen.getByText("Sprint 2")).toBeTruthy());
    expect(screen.getByText("Sprint 1")).toBeTruthy();
    FACETS.intervals.pop();
  });

  it("drops the value clause — never 'Unknown' — for a since-deleted interval", async () => {
    feedRows = [row({ newValue: "9a3e21c0-0000-4000-8000-000000000000" })];
    renderFeed();

    await waitFor(() => expect(screen.getByText("ENG-46")).toBeTruthy());
    expect(screen.queryByText("Unknown")).toBeNull();
    // No raw GUID either.
    expect(document.body.textContent).not.toContain("9a3e21c0");
  });

  it("names a status change's lane instead of printing the raw slug", async () => {
    feedRows = [row({ id: "a2", field: "columnKey", newValue: "in_progress" })];
    renderFeed();

    await waitFor(() => expect(screen.getByText("In Progress")).toBeTruthy());
    expect(screen.queryByText("in_progress")).toBeNull();
  });
});
