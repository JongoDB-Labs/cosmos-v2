// @vitest-environment jsdom
// COSMOS-88: right-click a board to create the board's item. A right-click on
// empty board space opens one "New issue" row at the cursor, pre-scoped by
// where it landed (a Status column, or a calendar day). It must leave every
// other right-click alone: a card's or row's own menu (which calls
// preventDefault first), and text fields and links, whose native menu
// (paste, open in new tab) is the one the user wants.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const perms = { canCreate: true };
vi.mock("@/components/providers/permissions-provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...actual,
    usePermissions: () => ({
      orgId: "o1",
      orgSlug: "acme",
      role: "MEMBER",
      permissions: 0n,
      can: (p: bigint) => (p === actual.Permission.ITEM_CREATE ? perms.canCreate : true),
    }),
  };
});

import { BoardCreateMenu } from "./board-create-menu";

const COLUMNS = [
  { key: "todo", name: "To Do" },
  { key: "review", name: "Review" },
];

function Board({
  onCreate,
  disabled,
}: {
  onCreate: (seed: unknown) => void;
  disabled?: boolean;
}) {
  return (
    <BoardCreateMenu columns={COLUMNS} onCreate={onCreate} disabled={disabled}>
      <div data-testid="board">
        <div data-board-column="review" data-testid="col-review">
          {/* A card with its own menu: it handles the right-click itself. */}
          <div data-testid="card" onContextMenu={(e) => e.preventDefault()}>
            card
          </div>
        </div>
        <div data-board-date="2026-10-24" data-testid="day" />
        <input data-testid="search" />
        <a href="https://example.com/docs" data-testid="link">
          link
        </a>
      </div>
    </BoardCreateMenu>
  );
}

afterEach(() => {
  cleanup();
  perms.canCreate = true;
});

/** fireEvent returns false when a handler called preventDefault, i.e. when the
 *  browser's own context menu was suppressed. */
function rightClick(el: Element) {
  return fireEvent.contextMenu(el, { clientX: 40, clientY: 60 });
}

describe("BoardCreateMenu", () => {
  it("creates into the right-clicked column", async () => {
    const onCreate = vi.fn();
    render(<Board onCreate={onCreate} />);

    expect(rightClick(screen.getByTestId("col-review"))).toBe(false);
    await userEvent.click(await screen.findByRole("menuitem", { name: "New issue in Review" }));

    expect(onCreate).toHaveBeenCalledWith({ columnKey: "review" });
  });

  it("creates on the right-clicked calendar day", async () => {
    const onCreate = vi.fn();
    render(<Board onCreate={onCreate} />);

    rightClick(screen.getByTestId("day"));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^New issue on / }));

    expect(onCreate).toHaveBeenCalledWith({ date: "2026-10-24" });
  });

  it("offers a plain New issue on empty board space", async () => {
    const onCreate = vi.fn();
    render(<Board onCreate={onCreate} />);

    rightClick(screen.getByTestId("board"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "New issue" }));

    expect(onCreate).toHaveBeenCalledWith({});
  });

  it("leaves a card's own right-click menu alone", () => {
    render(<Board onCreate={vi.fn()} />);

    rightClick(screen.getByTestId("card"));

    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("keeps the browser menu on text fields and links", () => {
    render(<Board onCreate={vi.fn()} />);

    expect(rightClick(screen.getByTestId("search"))).toBe(true);
    expect(rightClick(screen.getByTestId("link"))).toBe(true);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("does nothing for someone who cannot create items", () => {
    perms.canCreate = false;
    render(<Board onCreate={vi.fn()} />);

    expect(rightClick(screen.getByTestId("col-review"))).toBe(true);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("does nothing while disabled (the Kanban's bulk-select mode)", () => {
    render(<Board onCreate={vi.fn()} disabled />);

    expect(rightClick(screen.getByTestId("col-review"))).toBe(true);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
