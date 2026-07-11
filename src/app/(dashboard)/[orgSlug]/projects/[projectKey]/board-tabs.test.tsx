// @vitest-environment jsdom
//
// COSMOS-57 — project tabs must expose per-tab management (edit / delete /
// move) via BOTH a three-dot (kebab) menu button AND right-click, and those
// affordances must be discoverable, keyboard-closable, permission-gated, and
// persisted. The management strip itself was built incrementally (rename/move
// 2.91, hide/show 2.108–2.109, unified reorder/set-default 2.110–2.111,
// project-wide default 2.164) but had no test pinning the acceptance contract;
// this locks it so a refactor of ProjectBoardTabs / ActionMenu can't silently
// drop the menu, the right-click parity, the delete confirmation, the
// persistence, or the manager gating.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

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
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/PROJ/boards/sprint",
  useRouter: () => ({ push, refresh }),
}));

import { ProjectBoardTabs } from "./board-tabs";

const baseProps = {
  orgSlug: "acme",
  projectKey: "PROJ",
  orgId: "org1",
  projectId: "proj1",
  boards: [
    { id: "b1", name: "Sprint", type: "kanban", slug: "sprint" },
    { id: "b2", name: "Backlog", type: "table", slug: "backlog" },
  ],
  enabledFeatures: ["okr"],
  canManageBoards: true,
  canCreateBoards: true,
  canSetProjectDefault: true,
};

let fetchMock: ReturnType<typeof vi.fn>;

afterEach(cleanup);
beforeEach(() => {
  push.mockClear();
  refresh.mockClear();
  fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

const kebab = (name: RegExp) => screen.getByRole("button", { name });
const menuLabels = () => screen.queryAllByRole("menuitem").map((m) => m.textContent);

describe("ProjectBoardTabs — per-tab management menu (COSMOS-57)", () => {
  it("renders a labeled kebab trigger for every tab", () => {
    render(<ProjectBoardTabs {...baseProps} />);
    // One per board + one per enabled feature tab (okr).
    expect(kebab(/Tab actions for Sprint/)).toBeInTheDocument();
    expect(kebab(/Tab actions for Backlog/)).toBeInTheDocument();
    expect(kebab(/Tab actions for OKRs/)).toBeInTheDocument();
  });

  it("keeps the tab kebab persistently visible (not hover-only) so it is discoverable", () => {
    render(<ProjectBoardTabs {...baseProps} />);
    // The app-wide ⋯ is opacity-0 until hover; project tabs override that so the
    // three-dot affordance is actually shown. twMerge drops the base opacity-0.
    const cls = kebab(/Tab actions for Sprint/).getAttribute("class") ?? "";
    expect(cls).toContain("opacity-70");
    expect(cls).not.toContain("opacity-0");
    // …but it still brightens on hover/focus/open.
    expect(cls).toContain("group-hover/action:opacity-100");
  });

  it("kebab click opens Edit + Delete + Move for a manager", () => {
    render(<ProjectBoardTabs {...baseProps} />);
    fireEvent.click(kebab(/Tab actions for Sprint/));
    const labels = menuLabels();
    expect(labels).toContain("Rename board"); // Edit
    expect(labels).toContain("Delete board"); // Delete
    expect(labels).toContain("Move left"); // Move
    expect(labels).toContain("Move right");
  });

  it("right-click opens the SAME menu as the kebab", () => {
    render(<ProjectBoardTabs {...baseProps} />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Sprint/ }));
    const labels = menuLabels();
    expect(labels).toContain("Rename board");
    expect(labels).toContain("Delete board");
    expect(labels).toContain("Move left");
  });

  it("Delete asks for confirmation before removing the tab", () => {
    render(<ProjectBoardTabs {...baseProps} />);
    fireEvent.click(kebab(/Tab actions for Sprint/));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete board/ }));
    // A confirmation dialog appears — no DELETE fired yet.
    expect(screen.getByRole("dialog")).toHaveTextContent(/Delete board\?/);
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE"),
    ).toBe(false);
    // Confirming issues the DELETE to the board endpoint.
    fireEvent.click(screen.getByRole("button", { name: /^Delete board$/ }));
    const del = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "DELETE");
    expect(del?.[0]).toBe("/api/v1/orgs/org1/projects/proj1/boards/b1");
  });

  it("Edit opens a rename dialog prefilled with the tab name", () => {
    render(<ProjectBoardTabs {...baseProps} />);
    fireEvent.click(kebab(/Tab actions for Sprint/));
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename board/ }));
    const input = screen.getByPlaceholderText(/Board name/) as HTMLInputElement;
    expect(input.value).toBe("Sprint");
  });

  it("Move persists a reordered token list (survives reload)", () => {
    render(<ProjectBoardTabs {...baseProps} />);
    fireEvent.click(kebab(/Tab actions for Sprint/));
    fireEvent.click(screen.getByRole("menuitem", { name: /Move right/ }));
    const call = fetchMock.mock.calls.at(-1)!;
    expect(call[0]).toBe("/api/v1/orgs/org1/projects/proj1/tab-prefs");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      tabOrder: ["board:b2", "board:b1", "feature:okr"],
    });
    expect((call[1] as RequestInit).method).toBe("PUT");
  });

  it("closes the menu on Escape (keyboard accessible)", () => {
    render(<ProjectBoardTabs {...baseProps} />);
    fireEvent.click(kebab(/Tab actions for Sprint/));
    expect(menuLabels().length).toBeGreaterThan(0);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(menuLabels().length).toBe(0);
  });

  it("gates Edit/Delete of a shared board behind manage permission", () => {
    render(
      <ProjectBoardTabs
        {...baseProps}
        canManageBoards={false}
        canCreateBoards={false}
        canSetProjectDefault={false}
      />,
    );
    fireEvent.click(kebab(/Tab actions for Sprint/));
    const labels = menuLabels();
    // Non-managers can still reorder / hide their own strip, but must NOT be
    // able to rename or delete the shared board row.
    expect(labels).not.toContain("Rename board");
    expect(labels).not.toContain("Delete board");
    expect(labels).toContain("Move left");
    expect(labels).toContain("Hide tab");
  });
});
