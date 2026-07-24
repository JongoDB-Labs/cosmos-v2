// @vitest-environment jsdom
// COSMOS-45 — every issue/card reference should be clickable + editable from any
// view. The Release Timeline used to be a dead-end read-only snapshot: its
// increment bands and deliverable/milestone chips were inert <div>s with no way
// to open, edit, or right-click them. This locks in the fix:
//   1. Each plotted item is a real <a> link to its own editable surface, deep-
//      linked (`?open=<id>`) so a click lands on that exact item's detail.
//   2. The shared ActionMenu wraps every chip, so right-click / context-menu
//      actions ("Open", "Open in new tab") match the other board views.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- base-ui needs these in jsdom (see memory: testing-base-ui-in-jsdom) ---
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

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/release-timeline",
  useRouter: () => ({ push }),
}));

const CYCLES = [
  {
    id: "c1",
    name: "PI-1",
    startDate: "2026-01-01T00:00:00.000Z",
    endDate: "2026-02-01T00:00:00.000Z",
  },
];
const DELIVERABLES = [
  {
    id: "d1",
    code: "CDRL-A001",
    title: "System Spec",
    baselineDue: "2026-01-15T00:00:00.000Z",
    status: "IN_PROGRESS",
  },
];
const MILESTONES = [
  {
    id: "m1",
    title: "Kickoff",
    name: "Kickoff",
    dueDate: "2026-01-20T00:00:00.000Z",
    status: "UPCOMING",
  },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/intervals")) return Promise.resolve(CYCLES);
    if (url.endsWith("/deliverables")) return Promise.resolve(DELIVERABLES);
    if (url.endsWith("/milestones")) return Promise.resolve(MILESTONES);
    return Promise.resolve([]);
  }),
}));

import { ReleaseTimelineView } from "./release-timeline-view";

function renderView() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ReleaseTimelineView
        orgId="o1"
        projectId="p1"
        projectKey="FSC"
        boardId="release-timeline"
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  push.mockReset();
});

describe("ReleaseTimelineView — clickable references (COSMOS-45)", () => {
  it("renders each deliverable as a link that deep-links to its detail drawer", async () => {
    renderView();
    const link = await screen.findByRole("link", { name: /CDRL-A001/ });
    expect(link).toHaveAttribute(
      "href",
      "/acme/projects/FSC/pm-dashboard/deliverables?open=d1",
    );
  });

  it("renders each increment as a link to the intervals workspace", async () => {
    renderView();
    const link = await screen.findByRole("link", { name: /PI-1/ });
    expect(link).toHaveAttribute("href", "/acme/projects/FSC/intervals");
  });

  it("deep-links milestone chips once the milestones level is shown", async () => {
    renderView();
    await screen.findByRole("link", { name: /CDRL-A001/ });
    // Milestones are an opt-in overlay; turning them on plots the chip.
    fireEvent.click(screen.getByRole("checkbox", { name: /Milestones/ }));
    const link = await screen.findByRole("link", { name: /Kickoff/ });
    expect(link).toHaveAttribute(
      "href",
      "/acme/projects/FSC/milestones?open=m1",
    );
  });

  it("exposes right-click / context-menu actions on a plotted item", async () => {
    renderView();
    await screen.findByRole("link", { name: /CDRL-A001/ });
    // The shared ActionMenu wraps every chip. Opening it (same menu the
    // right-click handler triggers) surfaces the Open / Open-in-new-tab actions.
    fireEvent.click(
      screen.getByRole("button", { name: /Actions for CDRL-A001/ }),
    );
    await waitFor(() =>
      expect(screen.getByText("Open in new tab")).toBeInTheDocument(),
    );
    expect(screen.getByText("Open")).toBeInTheDocument();
  });
});
