// @vitest-environment jsdom
// The Calendar's month arrows were icon-only `<Button>`s with no text, no
// `aria-label` and no `title` -- so their accessible name was empty. A screen
// reader announces "button", and speech input has nothing to say.
//
// Two reasons this survived:
//   1. The axe gate reads `wcag2a`/`wcag2aa` (e2e/fixtures/axe.ts:31), and
//      `button-name` IS in that set -- but `a11y.spec.ts` only visits
//      `/projects/{KEY}` (which redirects to the default KANBAN board) and
//      `/projects/{KEY}/boards/new`. No spec ever loads a Calendar board, so
//      the rule that would have caught this never ran on this markup.
//   2. The sibling controls got it right. Timeline's zoom buttons all carry
//      both `aria-label` and `title`, so a reader comparing boards sees a
//      convention that the Calendar simply does not follow.
//
// Names, not just labels: the accessible name must also contain the visible
// intent so speech input ("click next month") matches -- these buttons have no
// visible text at all, so the label IS the name.
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
vi.mock("@/components/boards/shared/board-query-bar", () => ({
  BoardQueryBar: () => null,
}));
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => (
    <button type="button" data-testid="new-issue">
      New issue
    </button>
  ),
}));
vi.mock("@/components/work-items/board-item-detail-sheet", () => ({
  BoardItemDetailSheet: () => null,
}));

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url === "/api/v1/me")
      return Promise.resolve({
        id: "me",
        email: "me@x.com",
        displayName: "Me",
      });
    return Promise.resolve([]);
  }),
}));

import { CalendarView } from "./calendar-view";

function renderCalendar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CalendarView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("Calendar month navigation is nameable", () => {
  it("names the previous-month control", async () => {
    renderCalendar();
    expect(
      await screen.findByRole("button", { name: /previous month/i }),
    ).toBeTruthy();
  });

  it("names the next-month control", async () => {
    renderCalendar();
    expect(
      await screen.findByRole("button", { name: /next month/i }),
    ).toBeTruthy();
  });

  it("leaves no button on the month bar without an accessible name", async () => {
    // The general property, so a future icon-only control cannot slip in
    // unnamed the way these two did.
    renderCalendar();
    await screen.findByRole("button", { name: /previous month/i });
    const unnamed = screen
      .getAllByRole("button")
      .filter(
        (b) => !(b.getAttribute("aria-label") || b.textContent || "").trim(),
      );
    expect(unnamed).toEqual([]);
  });

  it("still offers Today and New issue on the month bar", async () => {
    // Information-preservation control: naming the arrows must not disturb the
    // controls already on that bar.
    renderCalendar();
    expect(await screen.findByRole("button", { name: /today/i })).toBeTruthy();
    expect(screen.getByTestId("new-issue")).toBeTruthy();
  });
});
