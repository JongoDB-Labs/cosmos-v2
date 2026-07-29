// @vitest-environment jsdom
//
// The sprint pills are the one obvious way to move between sprints on a SCRUM
// board, and they used to open a read-only modal — clicking "Sprint 3" left the
// board still showing Sprint 1. These lock the pills to the board's actual
// scope, in both directions:
//   · clicking a pill re-scopes the Kanban (it seeds its interval filter from
//     `initialIntervalId` in a useState initializer, so the prop changing is the
//     only thing that can move it after mount),
//   · a change made in the board's own filter bar is echoed back up, so the
//     pill highlight can't drift away from what the board is showing.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));

// The Kanban is a large tree with its own fetching; stand in for it and record
// the scope it was handed. `onIntervalChange` is captured so a test can simulate
// the board re-scoping itself from its filter bar.
const boardProps: {
  initialIntervalId?: string;
  onIntervalChange?: (id: string | null) => void;
}[] = [];
vi.mock("@/components/boards/kanban/kanban-board", () => ({
  KanbanBoard: (props: {
    initialIntervalId?: string;
    onIntervalChange?: (id: string | null) => void;
  }) => {
    boardProps.push(props);
    return <div data-testid="kanban" data-interval={props.initialIntervalId ?? ""} />;
  },
}));
vi.mock("@/components/intervals/intervals-workspace", () => ({
  IntervalsWorkspace: () => null,
}));

import { SprintBoard } from "./sprint-board";

const SPRINTS = [
  {
    id: "s1",
    name: "Sprint 1",
    number: 1,
    intervalKind: "SPRINT",
    status: "COMPLETED",
    goal: "Ship the importer",
    startDate: "2026-01-01T00:00:00.000Z",
    endDate: "2026-01-14T00:00:00.000Z",
    report: { velocity: 21, completedItems: 7, incompleteItems: 2 },
    _count: { workItems: 9 },
  },
  {
    id: "s2",
    name: "Sprint 2",
    number: 2,
    intervalKind: "SPRINT",
    status: "ACTIVE",
    goal: "Land the planner",
    startDate: "2026-01-15T00:00:00.000Z",
    endDate: "2026-01-28T00:00:00.000Z",
    report: null,
    _count: { workItems: 4 },
  },
];

function mockFetch(data: unknown = SPRINTS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(data) })),
  );
}

function renderBoard() {
  return render(
    <SprintBoard orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />,
  );
}

const lastScope = () => boardProps[boardProps.length - 1]?.initialIntervalId;

afterEach(() => {
  cleanup();
  boardProps.length = 0;
  vi.unstubAllGlobals();
});

describe("SprintBoard — sprint pills", () => {
  it("opens scoped to the active sprint", async () => {
    mockFetch();
    renderBoard();
    await screen.findByTestId("kanban");
    expect(lastScope()).toBe("s2");
    // The header describes the sprint the board is showing.
    expect(screen.getByRole("heading", { name: "Sprint 2" })).toBeTruthy();
  });

  it("re-scopes the board when another sprint's pill is clicked", async () => {
    mockFetch();
    renderBoard();
    await screen.findByTestId("kanban");

    fireEvent.click(screen.getByRole("button", { name: "Sprint 1" }));

    await waitFor(() => expect(lastScope()).toBe("s1"));
    // …and the header follows, rather than describing a sprint that is no
    // longer on screen.
    expect(screen.getByRole("heading", { name: "Sprint 1" })).toBeTruthy();
  });

  it("marks only the shown sprint as pressed", async () => {
    mockFetch();
    renderBoard();
    await screen.findByTestId("kanban");

    expect(screen.getByRole("button", { name: "Sprint 2" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Sprint 1" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Sprint 1" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sprint 1" }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(screen.getByRole("button", { name: "Sprint 2" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("clears the scope via All items, and does not snap back to the active sprint", async () => {
    // The regression guarded here: "nothing picked yet" and "explicitly cleared"
    // are different states. Collapsing them makes All items bounce straight back.
    mockFetch();
    renderBoard();
    await screen.findByTestId("kanban");

    fireEvent.click(screen.getByRole("button", { name: "All items" }));

    await waitFor(() => expect(lastScope()).toBeUndefined());
    expect(screen.getByRole("button", { name: "All items" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("follows the board when the scope is changed from its filter bar", async () => {
    mockFetch();
    renderBoard();
    await screen.findByTestId("kanban");

    // The board reports its own change upward (what the filter bar does).
    boardProps[boardProps.length - 1].onIntervalChange?.("s1");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sprint 1" }).getAttribute("aria-pressed")).toBe("true"),
    );
  });

  it("shows the close-out report for a finished sprint", async () => {
    // These numbers only existed in the modal the pills used to open; losing
    // them along with the modal would be a silent regression.
    mockFetch();
    renderBoard();
    await screen.findByTestId("kanban");

    fireEvent.click(screen.getByRole("button", { name: "Sprint 1" }));

    expect(await screen.findByText("21 pts")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });
});
