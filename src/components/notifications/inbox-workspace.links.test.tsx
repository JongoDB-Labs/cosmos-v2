// @vitest-environment jsdom
//
// Every inbox row links to the notification's target inside the current org,
// with the org slug exactly once. On 2.465.0 a stored "/{slug}/issues?item=…"
// was prefixed again, so every row pointed at "/{slug}/{slug}/…" and opened a 404.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/inbox" }));

const PAGE = {
  data: [
    { id: "n1", type: "work_item.assigned", title: "Assigned: PRJ-1", body: "", url: "/acme/issues?item=w1", read: false, createdAt: "2026-10-20T10:00:00.000Z" },
    { id: "n2", type: "work_item.mention", title: "Mentioned on PRJ-2", body: "", url: "/issues?item=w2", read: false, createdAt: "2026-10-19T10:00:00.000Z" },
    { id: "n3", type: "feedback.status", title: "Your report is being worked on", body: "", url: "/acme/feedback", read: true, createdAt: "2026-10-18T10:00:00.000Z" },
  ],
  nextCursor: null,
  counts: { total: 3, unread: 2, byType: [] },
};
const { jsonFetch } = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch }));

import { InboxWorkspace } from "./inbox-workspace";

afterEach(() => cleanup());

describe("InboxWorkspace — row links", () => {
  it("prefixes the org slug exactly once, whichever form the URL was stored in", async () => {
    jsonFetch.mockResolvedValue(PAGE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <InboxWorkspace orgId="o1" />
      </QueryClientProvider>,
    );
    const href = async (title: string) =>
      (await screen.findByText(title)).closest("a")?.getAttribute("href");

    expect(await href("Assigned: PRJ-1")).toBe("/acme/issues?item=w1");
    expect(await href("Mentioned on PRJ-2")).toBe("/acme/issues?item=w2");
    expect(await href("Your report is being worked on")).toBe("/acme/feedback");
  });
});
