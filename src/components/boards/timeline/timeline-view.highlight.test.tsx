// @vitest-environment jsdom
//
// The card highlight has to reach the Gantt too — a meeting that reads status
// off the board should read the same status off the schedule.
//
// It cannot use the channel the DOM cards use. A bar's outline is spoken for,
// and says so in a comment on the bar itself: "a border here would compete with
// the outlines that mean blocked / critical / enabler, which are the only
// things allowed to change a bar's edge." So the highlight is an inset marker
// along the shape's bottom edge, and these tests pin that it is drawn, that it
// is NOT drawn when there is no highlight, and that it never touches `stroke`.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/projects/FSC/boards/b1" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/boards/shared/new-issue-button", () => ({ NewIssueButton: () => null }));
vi.mock("@/components/work-items/card-detail-sheet", () => ({ CardDetailSheet: () => null }));
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/boards/shared/filter-bar")>();
  return { ...actual, FilterBar: () => null };
});

const item = (
  n: number,
  start: string | null,
  due: string | null,
  extra: Record<string, unknown> = {},
) => ({
  id: `i${n}`,
  ticketNumber: 100 + n,
  title: `Item ${n}`,
  createdAt: "2026-01-05",
  startDate: start,
  dueDate: due,
  columnKey: "todo",
  workItemType: { key: "TASK", name: "Task" },
  priority: "MEDIUM",
  workCategory: "BUSINESS",
  parentId: null,
  children: [],
  assigneeId: null,
  assignees: [],
  actualStart: null,
  storyPoints: null,
  completedAt: null,
  highlight: null,
  ...extra,
});

const ITEMS = [
  item(1, "2026-01-05", "2026-01-20", { highlight: "AMBER" }),
  item(2, "2026-01-10", "2026-02-01"), // no highlight — the negative control
  item(3, null, null, { highlight: "RED" }), // undated → the dot path
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
import { HighlightUnderline } from "@/components/work-items/highlight-underline";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderTimeline = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TimelineView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );

describe("HighlightUnderline", () => {
  const renderSvg = (props: React.ComponentProps<typeof HighlightUnderline>) =>
    render(
      <svg>
        <HighlightUnderline {...props} />
      </svg>,
    );

  it("draws nothing at all when there is no highlight", () => {
    const { container } = renderSvg({ highlight: null, x: 0, y: 0, width: 50, height: 20 });
    expect(container.querySelector("rect")).toBeNull();
  });

  it("draws nothing for a value this build does not recognise", () => {
    // Never `var(undefined)`, which paints as currentColor — a highlight on a
    // card nobody highlighted.
    const { container } = renderSvg({
      highlight: "FUCHSIA_FROM_A_NEWER_BUILD",
      x: 0,
      y: 0,
      width: 50,
      height: 20,
    });
    expect(container.querySelector("rect")).toBeNull();
  });

  it("insets the marker along the bottom edge, inside the row", () => {
    const { container } = renderSvg({ highlight: "AMBER", x: 10, y: 100, width: 50, height: 20 });
    const rect = container.querySelector("rect")!;
    expect(rect.getAttribute("fill")).toBe("var(--status-blocked-text)");
    expect(rect.getAttribute("x")).toBe("10");
    // y + height - thickness → inside the row, so it cannot bleed into the next.
    expect(rect.getAttribute("y")).toBe("117");
    expect(rect.getAttribute("height")).toBe("3");
  });

  it("never sets stroke — that channel means blocked / critical / enabler", () => {
    const { container } = renderSvg({ highlight: "RED", x: 0, y: 0, width: 50, height: 20 });
    expect(container.querySelector("rect")!.getAttribute("stroke")).toBeNull();
  });

  it("carries the colour's meaning as a title", () => {
    const { container } = renderSvg({ highlight: "AMBER", x: 0, y: 0, width: 50, height: 20 });
    expect(container.querySelector("title")?.textContent).toBe("At risk");
  });

  it("draws nothing for a zero-width shape", () => {
    const { container } = renderSvg({ highlight: "AMBER", x: 0, y: 0, width: 0, height: 20 });
    expect(container.querySelector("rect")).toBeNull();
  });
});

describe("TimelineView — the highlight reaches the chart", () => {
  it("marks a dated bar and an undated dot, and leaves an unhighlighted item bare", async () => {
    const { container } = renderTimeline();
    await screen.findByText(/FSC-101/);

    const marks = [...container.querySelectorAll("rect[data-highlight]")].map((r) =>
      r.getAttribute("data-highlight"),
    );
    // One for the dated bar (AMBER), one for the undated dot (RED).
    expect(marks.sort()).toEqual(["AMBER", "RED"]);
    // The negative control: three items render, only two are marked. Without
    // this, a component that marked everything would pass the line above.
    expect(marks).toHaveLength(2);
  });

  it("paints the marker AFTER its shape, so an opaque bar cannot cover it", async () => {
    // SVG has no z-index: paint order IS document order. The first cut put the
    // marker before the bar, which looked correct on screen only because an
    // unstarted bar is a semi-transparent phantom and the colour bled through
    // dimmed. A started bar is opaque and would have hidden it outright —
    // invisible in exactly the case a meeting cares most about.
    //
    // Asserting existence alone passed against that bug, which is why this
    // assertion is separate.
    const { container } = renderTimeline();
    await screen.findByText(/FSC-101/);

    for (const mark of container.querySelectorAll("rect[data-highlight]")) {
      const siblings = [...mark.parentElement!.children];
      const shapes = siblings.filter(
        (el) => /^(rect|polygon|circle)$/.test(el.tagName) && el !== mark,
      );
      const lastShape = shapes[shapes.length - 1];
      expect(
        siblings.indexOf(mark),
        `the ${mark.getAttribute("data-highlight")} marker must paint after every shape in its group`,
      ).toBeGreaterThan(siblings.indexOf(lastShape));
    }
  });
});
