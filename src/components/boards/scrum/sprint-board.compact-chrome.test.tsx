// @vitest-environment jsdom
//
// ffe324aa: the sprint board is "clunky and spread out ... taking up so much
// board real estate with dropdowns and such".
//
// The cause was structural, not cosmetic. The sprint context rendered as TWO
// bordered bands — a `py-4` header (heading, a wrapping goal paragraph, a
// full-width progress bar with a caption under it, a boxed close-out report)
// stacked on a second `py-2` row for the sprint pills — above a board that then
// adds its own filter bar, scope notice and toolbar. Five horizontal bands
// before the first card.
//
// jsdom computes no layout, so this file cannot assert pixels. It asserts the
// thing that actually caused them: how many bands the chrome is, and that the
// goal is a truncating single line rather than a paragraph free to wrap to
// three. A screenshot would show the symptom; this shows the cause, and it
// fails if either band comes back.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { SprintBoard } from "./sprint-board";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/projects/ALPHA/boards/b1" }));
vi.mock("@/components/boards/kanban/kanban-board", () => ({
  KanbanBoard: () => <div data-testid="kanban" />,
}));
vi.mock("@/components/intervals/intervals-workspace", () => ({ IntervalsWorkspace: () => null }));

const LONG_GOAL =
  "Ship the connector rewrite end to end, including the retry path, the " +
  "back-pressure fix, and the migration for the legacy payload shape";

const SPRINTS = [
  {
    id: "s1",
    name: "Sprint 1",
    number: 1,
    intervalKind: "SPRINT",
    status: "ACTIVE",
    goal: LONG_GOAL,
    startDate: "2026-01-15T00:00:00.000Z",
    endDate: "2026-01-28T00:00:00.000Z",
    report: null,
    parentId: null,
    _count: { workItems: 4 },
  },
];

afterEach(cleanup);

function renderBoard(data: unknown = SPRINTS) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(data) })));
  const { container } = render(
    <SprintBoard orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />,
  );
  return container;
}

/** Every horizontal rule between the top of the board and the Kanban. Each one
 *  is a visual band, and each band is vertical space the board does not get. */
const bands = (container: HTMLElement) =>
  container.querySelectorAll('[class*="border-b"]');

describe("the sprint context is ONE band", () => {
  it("draws a single bordered bar above the board, not a header plus a picker row", async () => {
    const container = renderBoard();
    await screen.findByTestId("kanban");
    expect(bands(container)).toHaveLength(1);
  });

  it("still shows everything that band is for", async () => {
    // The cut must not have been achieved by dropping information. Each of
    // these had its own line or block in the old header.
    renderBoard();
    await screen.findByTestId("kanban");

    expect(screen.getByRole("heading", { name: "Sprint 1" })).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(LONG_GOAL)).toBeTruthy();
    expect(screen.getByText(/4 items/)).toBeTruthy();
    expect(screen.getByText(/days? left/)).toBeTruthy();
    // The pills, and the escape hatch back to the unscoped board.
    expect(screen.getByRole("button", { name: "Sprint 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All items" })).toBeTruthy();
  });

  it("keeps the goal to one line, with the full text still reachable", async () => {
    renderBoard();
    await screen.findByTestId("kanban");

    const goal = screen.getByText(LONG_GOAL);
    // `truncate` is what stops a sentence-long goal claiming two or three lines
    // above every board. Losing it is the regression, so assert it directly.
    expect(goal.className).toMatch(/\btruncate\b/);
    // Truncated on screen must not mean unreadable: the full goal is on hover.
    expect(goal.closest("[title]")?.getAttribute("title")).toBe(LONG_GOAL);
  });

  it("drops the day caption to a tooltip rather than its own line", async () => {
    renderBoard();
    await screen.findByTestId("kanban");
    // "Day 5 of 14" used to sit under a full-width bar on a line of its own.
    expect(screen.queryByText(/^Day \d+ of \d+$/)).toBeNull();
    await waitFor(() =>
      expect(document.querySelector('[title^="Day "]')).toBeTruthy(),
    );
  });
});
