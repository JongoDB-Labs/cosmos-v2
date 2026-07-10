// @vitest-environment jsdom
// COSMOS-11 — regression guard for Base UI production error #31 on the boards
// route. ActionMenu is the shared ⋯ / right-click menu rendered on every board
// (kanban cards, table rows, RAID, backlog…). It previously rendered a bare
// `DropdownMenuLabel` for a group's title, which throws #31 the instant the
// menu opens (see 2.57.5 and dropdown-menu.test.tsx). If the group wrapping
// ever regresses, opening a labeled ActionMenu here throws again and this fails.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ActionMenu } from "./action-menu";

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

afterEach(cleanup);

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
}

describe("ActionMenu (Base UI #31 regression)", () => {
  it("opens a LABELED group without throwing #31 and shows label + items", () => {
    render(
      <ActionMenu
        groups={[
          {
            label: "Priority",
            items: [{ label: "Set high", onClick: () => {} }],
          },
        ]}
      >
        <span>row</span>
      </ActionMenu>,
    );

    // The bug threw during the open render; reaching these assertions proves it
    // opened cleanly.
    expect(() => openMenu()).not.toThrow();
    expect(screen.getByText("Priority")).toBeInTheDocument();
    expect(screen.getByText("Set high")).toBeInTheDocument();
    // The restored group semantics: the label names its group.
    const group = screen.getByRole("group");
    expect(group).toHaveAttribute("aria-labelledby", screen.getByText("Priority").id);
  });

  it("also opens an UNLABELED group cleanly (no stray label/group crash)", () => {
    render(
      <ActionMenu groups={[{ items: [{ label: "Delete", onClick: () => {} }] }]}>
        <span>row</span>
      </ActionMenu>,
    );

    expect(() => openMenu()).not.toThrow();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });
});
