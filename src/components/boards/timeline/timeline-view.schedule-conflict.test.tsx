// @vitest-environment jsdom
// Scheduling conflicts on the Gantt (FR COSMOS-154).
//
// Saving a date now cascades — parents stretch to their children's envelope and
// downstream successors shift by the slip (`lib/work-items/schedule-cascade.ts`,
// unit-tested there). What CANNOT be cascaded away still has to be visible:
// a link added after both ends were scheduled, an item with no dates to shift,
// a cycle. The chart drew every dependency in the same neutral grey, so an
// arrow pointing BACKWARDS in time looked exactly like a healthy one.
//
// These tests prove the wiring: the violation reaches the toolbar as a count,
// and reaches the edge as colour. The pure function being right does not mean
// the component paints it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
vi.mock("@/components/boards/shared/new-issue-button", () => ({ NewIssueButton: () => null }));
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/boards/shared/filter-bar")>();
  return { ...actual, FilterBar: () => null };
});

const item = (id: string, ticketNumber: number, start: string, due: string) => ({
  id,
  ticketNumber,
  title: id,
  createdAt: start,
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
});

// `early` must finish before `late` begins, and does NOT — it runs to 15 Jan
// while `late` starts on the 10th. `after` is scheduled honestly behind `late`.
const ITEMS = [
  item("early", 101, "2026-01-01", "2026-01-15"),
  item("late", 102, "2026-01-10", "2026-01-25"),
  item("after", 103, "2026-02-01", "2026-02-10"),
];

let activeItems: unknown[] = ITEMS;
let activeLinks: unknown[] = [];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(activeItems);
    if (url.endsWith("/members")) return Promise.resolve([]);
    if (url.endsWith("/work-item-links")) return Promise.resolve(activeLinks);
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

async function renderTimeline(links: unknown[], items: unknown[] = ITEMS) {
  activeItems = items;
  activeLinks = links;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <TimelineView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
  await screen.findByText("Work Items");
  await screen.findByTestId("gantt-bar-early");
  return utils;
}

const link = (id: string, type: string, sourceItemId: string, targetItemId: string, s: number, t: number) => ({
  id,
  type,
  sourceItemId,
  targetItemId,
  sourceTicketNumber: s,
  targetTicketNumber: t,
});

const badge = () => screen.queryByRole("button", { name: /scheduling conflict/i });

describe("TimelineView — the scheduling-conflict badge", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    activeLinks = [];
    vi.clearAllMocks();
  });

  it("counts a predecessor that still finishes after the item waiting on it", async () => {
    await renderTimeline([link("l1", "PREDECESSOR", "early", "late", 101, 102)]);
    expect(badge()).toHaveTextContent("1 scheduling conflict");
  });

  it("stays silent when every link's dates line up", async () => {
    // `late` ends 25 Jan, `after` starts 1 Feb — a perfectly legal hand-off.
    await renderTimeline([link("l1", "PREDECESSOR", "late", "after", 102, 103)]);
    expect(badge()).toBeNull();
  });

  it("reads BLOCKED_BY in the reverse direction, like the arrows do", async () => {
    // "early BLOCKED_BY after" means `after` comes first — and `after` finishes
    // in February, long after `early` began. Flagging the wrong end here would
    // point the user at an item that is not the problem.
    await renderTimeline([link("l1", "BLOCKED_BY", "early", "after", 101, 103)]);
    expect(badge()).toHaveTextContent("1 scheduling conflict");
    cleanup();
    // …and the same pair the other way round is fine.
    await renderTimeline([link("l1", "BLOCKED_BY", "after", "early", 103, 101)]);
    expect(badge()).toBeNull();
  });

  it("ignores soft RELATES links — they impose no ordering to violate", async () => {
    await renderTimeline([link("l1", "RELATES", "early", "late", 101, 102)]);
    expect(badge()).toBeNull();
  });

  it("pluralises, and counts each violated constraint once", async () => {
    await renderTimeline([
      link("l1", "PREDECESSOR", "early", "late", 101, 102),
      // The SAME constraint stated from the other end. One problem, not two.
      link("l2", "SUCCESSOR", "late", "early", 102, 101),
      link("l3", "PREDECESSOR", "after", "late", 103, 102),
    ]);
    expect(badge()).toHaveTextContent("2 scheduling conflicts");
  });

  it("turns the Dependencies lens on so the arrows explain it", async () => {
    await renderTimeline([link("l1", "PREDECESSOR", "early", "late", 101, 102)]);
    const deps = screen.getByRole("button", { name: /^dependencies$/i });
    expect(deps).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(badge()!);
    expect(deps).toHaveAttribute("aria-pressed", "true");
  });
});

describe("TimelineView — a violated edge is drawn as one", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    activeLinks = [];
    vi.clearAllMocks();
  });

  async function renderWithArrows() {
    await renderTimeline([
      link("bad", "PREDECESSOR", "early", "late", 101, 102),
      link("good", "PREDECESSOR", "late", "after", 102, 103),
    ]);
    // The badge opens the lens WITHOUT refetching the links, so the arrows are
    // on screen immediately.
    fireEvent.click(badge()!);
  }

  /** The dependency arrow whose tooltip names this pair. `getByTitle` can't
   *  reach an SVG <title> nested inside a <path>, so query the paths directly. */
  const arrow = (from: number, to: number) => {
    const match = Array.from(document.querySelectorAll("path")).find((p) =>
      p.textContent?.startsWith(`FSC-${from} PREDECESSOR FSC-${to}`),
    );
    if (!match) throw new Error(`no dependency arrow FSC-${from} -> FSC-${to}`);
    return match;
  };

  it("paints the impossible hand-off red, and the honest one neutral", async () => {
    await renderWithArrows();
    const bad = arrow(101, 102);
    const good = arrow(102, 103);
    expect(bad.getAttribute("stroke")).toBe("var(--status-critical)");
    expect(Number(bad.getAttribute("stroke-width"))).toBe(2.5);
    expect(good.getAttribute("stroke")).not.toBe("var(--status-critical)");
    expect(Number(good.getAttribute("stroke-width"))).toBeLessThan(2.5);
  });

  it("says by how much, in the arrow's own tooltip", async () => {
    await renderWithArrows();
    // 15 Jan finish against a 10 Jan start: five days of overrun.
    expect(arrow(101, 102).textContent).toMatch(
      /finishes 5 days after the item waiting on it/,
    );
    expect(arrow(102, 103).textContent).not.toMatch(/finishes/);
  });
});
