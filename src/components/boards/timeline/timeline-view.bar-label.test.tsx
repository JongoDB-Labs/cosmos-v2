// @vitest-environment jsdom
// The bar's title is an SVG <text> whose colour comes from `fill="white"`, set
// inline. A Tailwind `text-*` class on the same element paints a CSS `color`,
// which an SVG glyph never reads — so any such class is dead weight that reads
// like the thing deciding the label's colour. `BarColors` used to carry one per
// band (text-purple-100 / text-blue-100 / text-orange-100); this pins that the
// className stays free of colour so it cannot creep back in.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));

vi.mock("@/components/providers/permissions-provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...actual,
    usePermissions: () => ({
      orgId: "o1",
      orgSlug: "acme",
      role: "ADMIN",
      permissions: 0n,
      can: () => false,
    }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => null,
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/boards/shared/filter-bar")>();
  return { ...actual, FilterBar: () => null };
});

const item = (
  id: string,
  n: number,
  typeKey: string,
  start: string | null,
  due: string | null,
) => ({
  id,
  ticketNumber: n,
  title: `Item ${n}`,
  // Wide enough that the bar clears the 60px threshold the label renders above,
  // and — for the null-dated item — the createdAt the span falls back to.
  createdAt: "2026-01-05",
  startDate: start,
  dueDate: due,
  columnKey: "todo",
  workItemType: { key: typeKey, name: typeKey },
  priority: "MEDIUM",
  workCategory: "BUSINESS",
  parentId: null,
  children: [],
  assigneeId: null,
  assignees: [],
  actualStart: null,
  storyPoints: null,
  completedAt: null,
});

// One per colour band, since the dead class was a per-band field: an initiative
// (purple) and a delivery item (blue). `nodue` has a start and no due date, the
// case the bar renderer has to span through `itemSpan`'s start + 7 fallback.
const ITEMS = [
  item("epic", 901, "EPIC", "2026-01-05", "2026-01-25"),
  item("task", 902, "TASK", "2026-01-08", "2026-01-28"),
  item("nodue", 903, "TASK", "2026-01-05", null),
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve([]);
    if (url.endsWith("/work-item-links")) return Promise.resolve([]);
    if (url.endsWith("/intervals")) return Promise.resolve([]);
    if (url.endsWith("/milestones")) return Promise.resolve([]);
    if (url.includes("/boards/"))
      return Promise.resolve({
        id: "b1",
        columns: [
          { key: "todo", category: "TODO" },
          { key: "done", category: "DONE" },
        ],
      });
    return Promise.resolve([]);
  }),
}));

import { TimelineView } from "./timeline-view";

async function renderTimeline() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <TimelineView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
  await screen.findByText("Work Items");
  await screen.findByTestId("gantt-bar-epic");
  return utils;
}

describe("TimelineView — bar labels carry no dead text colour", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("gives the bar title an inline white fill and no Tailwind colour class", async () => {
    const { container } = await renderTimeline();

    const labels = Array.from(container.querySelectorAll("svg text")).filter((t) =>
      /^Item \d+/.test(t.textContent ?? ""),
    );
    // Guard the premise: if no label rendered, the assertions below are vacuous.
    expect(labels.length).toBeGreaterThanOrEqual(2);

    for (const label of labels) {
      expect((label as SVGTextElement).style.fill).toBe("white");
      const className = label.getAttribute("class") ?? "";
      expect(className).toBe("text-[10px]");
      // The specific classes `BarColors.text` used to supply, named so a revert
      // fails on the reason rather than on a whitespace diff.
      expect(className).not.toMatch(/text-(purple|blue|orange)-100/);
    }
  });

  it("spans an item with no due date across seven days from its start", async () => {
    await renderTimeline();

    // `itemSpan` is the one definition of that fallback and the renderer reads
    // it rather than repeating it. Measured against the 20-day `epic` bar so
    // this states the span in DAYS and stays true whatever the day width is.
    const dayWidth = Number(screen.getByTestId("gantt-bar-epic").getAttribute("width")) / 20;
    expect(dayWidth).toBeGreaterThan(0);

    const bar = screen.getByTestId("gantt-bar-nodue");
    expect(Number(bar.getAttribute("width")) / dayWidth).toBe(7);
    // Same start date as the epic, so the two bars must begin at the same x.
    expect(bar.getAttribute("x")).toBe(screen.getByTestId("gantt-bar-epic").getAttribute("x"));
  });
});
