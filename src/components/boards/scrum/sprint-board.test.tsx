// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

afterEach(cleanup);

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/PROJ/boards/board-1",
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// Only render the modal subtree when open, so the closed detail dialog doesn't
// pull in router-dependent children.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Stub the Kanban so the test observes exactly which cycle the Sprint board
// scopes it to (the whole point of the fix), without the full board stack. Its
// `key` (from the parent) forces a remount on switch, so `initialCycleId`
// reflects the currently-viewed sprint.
vi.mock("@/components/boards/kanban/kanban-board", () => ({
  KanbanBoard: ({ initialCycleId }: { initialCycleId?: string }) => (
    <div data-testid="kanban" data-cycle={initialCycleId ?? "none"} />
  ),
}));

import { SprintBoard } from "./sprint-board";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SPRINT_1 = {
  id: "s1",
  name: "Sprint 1",
  number: 1,
  cycleKind: "SPRINT",
  status: "COMPLETED",
  startDate: "2026-01-01T00:00:00.000Z",
  endDate: "2026-01-14T00:00:00.000Z",
  goal: null,
  report: null,
};

const SPRINT_5_ACTIVE = {
  id: "s5",
  name: "Sprint 5",
  number: 5,
  cycleKind: "SPRINT",
  status: "ACTIVE",
  startDate: "2026-06-01T00:00:00.000Z",
  endDate: "2026-06-14T00:00:00.000Z",
  goal: null,
  report: null,
};

function mockCyclesFetch(cycles: unknown[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => cycles,
  }) as unknown as typeof fetch;
}

function renderBoard() {
  render(
    <SprintBoard orgId="o1" projectId="p1" projectKey="PROJ" boardId="board-1" />,
  );
}

const kanban = () => screen.getByTestId("kanban");

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SprintBoard sprint scoping", () => {
  it("scopes the board to the active sprint on load", async () => {
    mockCyclesFetch([SPRINT_1, SPRINT_5_ACTIVE]);
    renderBoard();

    // Board opens focused on the ACTIVE sprint — not every item in the project.
    await waitFor(() => expect(kanban()).toHaveAttribute("data-cycle", "s5"));
  });

  it("re-scopes the board to the sprint the user selects", async () => {
    mockCyclesFetch([SPRINT_1, SPRINT_5_ACTIVE]);
    renderBoard();

    await waitFor(() => expect(kanban()).toHaveAttribute("data-cycle", "s5"));

    // Clicking a different sprint switches the board to it (the reported bug: the
    // chip used to only open a modal, leaving the board on the active sprint).
    fireEvent.click(screen.getByTitle("Sprint 1 — show this sprint's board"));

    await waitFor(() => expect(kanban()).toHaveAttribute("data-cycle", "s1"));
  });

  it("highlights the selected sprint via aria-pressed", async () => {
    mockCyclesFetch([SPRINT_1, SPRINT_5_ACTIVE]);
    renderBoard();

    // Target the switcher chip by its title (once viewed, the sprint's name also
    // appears as a header button, so match on the chip specifically).
    const chipTitle = "Sprint 1 — show this sprint's board";
    const sprint1Chip = await screen.findByTitle(chipTitle);
    // Active sprint (s5) is the default selection.
    expect(sprint1Chip).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(sprint1Chip);

    await waitFor(() =>
      expect(screen.getByTitle(chipTitle)).toHaveAttribute("aria-pressed", "true"),
    );
  });
});
