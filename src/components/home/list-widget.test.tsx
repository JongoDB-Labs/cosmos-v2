// @vitest-environment jsdom
//
// The Recent activity widget printed the DATABASE column name for a field
// change — "changed intervalId", "changed columnKey", "changed workItemTypeId".
// Same leak of internals as the reported "changed interval to Unknown" on the
// Activity page, one surface over; both now go through the shared field-label
// helper, so the widget can't drift from the feed's wording again.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme" }));

const ROWS = [
  {
    id: "a1",
    action: "updated",
    field: "intervalId",
    createdAt: new Date().toISOString(),
    actor: { displayName: "Dana Reyes" },
    item: { id: "w1", ticketKey: "ENG-46", title: "nimpt-rest" },
  },
  {
    id: "a2",
    action: "updated",
    field: "columnKey",
    createdAt: new Date().toISOString(),
    actor: { displayName: "Dana Reyes" },
    item: { id: "w2", ticketKey: "ENG-47", title: "another" },
  },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: () => Promise.resolve({ data: ROWS }),
}));

import { HomeListWidget } from "@/components/home/list-widget";

afterEach(cleanup);

describe("Recent activity widget — field names are human, not columns", () => {
  it("says 'changed interval' / 'changed status', never the column name", async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <HomeListWidget orgId="o1" orgSlug="acme" type="recent_activity" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("changed interval")).toBeTruthy());
    expect(screen.getByText("changed status")).toBeTruthy();
    expect(screen.queryByText("changed intervalId")).toBeNull();
    expect(screen.queryByText("changed columnKey")).toBeNull();
  });
});
