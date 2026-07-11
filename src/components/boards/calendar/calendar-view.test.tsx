// @vitest-environment jsdom
// COSMOS-51 — "Assigned to me" quick-filter on the Calendar view. Items are
// bucketed onto their due date; the toggle should narrow those buckets to the
// current user and restore the full set when pressed again.
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
}));

vi.mock("@/components/boards/shared/create-issue-button", () => ({
  CreateIssueButton: () => <button type="button">New issue</button>,
}));

// Place both items on distinct days of the *current* month so the default
// (today's month) calendar renders them without navigation. Noon-local avoids
// any TZ rollover of the bucket day.
const now = new Date();
const dueOn = (day: number) =>
  new Date(now.getFullYear(), now.getMonth(), day, 12, 0, 0).toISOString();

const ITEMS = [
  {
    id: "w1",
    ticketNumber: 1,
    title: "My cal task",
    priority: "MEDIUM",
    assigneeId: "me",
    dueDate: dueOn(10),
  },
  {
    id: "w2",
    ticketNumber: 2,
    title: "Their cal task",
    priority: "LOW",
    assigneeId: "other",
    dueDate: dueOn(20),
  },
];

const MEMBERS = [
  { userId: "me", user: { displayName: "Me" } },
  { userId: "other", user: { displayName: "Other" } },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url === "/api/v1/me")
      return Promise.resolve({ id: "me", email: "me@x.com", displayName: "Me" });
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve(MEMBERS);
    return Promise.resolve([]);
  }),
}));

import { CalendarView } from "./calendar-view";

const renderCalendar = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CalendarView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};

describe("CalendarView — Assigned to me", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("filters day buckets to the current user and restores when toggled off", async () => {
    renderCalendar();

    await screen.findByText("My cal task");
    expect(screen.getByText("Their cal task")).toBeInTheDocument();

    const btn = await screen.findByRole("button", { name: /assigned to me/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("My cal task")).toBeInTheDocument();
    expect(screen.queryByText("Their cal task")).toBeNull();

    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Their cal task")).toBeInTheDocument();
  });
});
