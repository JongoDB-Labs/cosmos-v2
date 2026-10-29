// @vitest-environment jsdom
//
// Turning a SAVED filter into a board used to mean knowing to run it first and
// then noticing a separate toolbar button, which acts on whatever query is in
// the bar. Nothing in this menu said a board was possible from a filter at all.
// It is now an action on the filter itself — and absent, rather than
// present-and-refused, for someone who cannot create boards.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

const FILTER = {
  id: "f1",
  name: "My open bugs",
  mine: true,
  favorite: false,
  favoriteOrder: 0,
  visibility: "PRIVATE",
  canEdit: true,
  canDelete: true,
};

vi.mock("./use-saved-filters", () => ({
  useSavedFilters: () => ({ data: [FILTER] }),
  useSavedFilterMutations: () => ({ star: { mutate: vi.fn() }, remove: { mutate: vi.fn() } }),
  recentFilterIds: () => [],
}));

import { FiltersMenu } from "./filters-menu";

function open(onSaveAsBoard?: (f: { name: string }) => void) {
  const r = render(
    <FiltersMenu
      orgId="o1"
      orgSlug="acme"
      activeId={null}
      onRun={() => {}}
      onEdit={() => {}}
      onSubscribe={() => {}}
      {...(onSaveAsBoard ? { onSaveAsBoard: onSaveAsBoard as never } : {})}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Saved filters" }));
  return r;
}

afterEach(cleanup);

describe("Saved menu — Save as board", () => {
  it("offers it on the filter itself", async () => {
    const onSaveAsBoard = vi.fn();
    open(onSaveAsBoard);
    fireEvent.click(await screen.findByText("My open bugs"));
    const item = await screen.findByText(/save as board/i);
    fireEvent.click(item);
    await waitFor(() => expect(onSaveAsBoard).toHaveBeenCalledTimes(1));
    // It must hand over THIS filter, so the board is named and scoped from it.
    expect(onSaveAsBoard.mock.calls[0][0]).toMatchObject({ id: "f1", name: "My open bugs" });
  });

  it("is a menuitem, not a button, so it cannot shadow the toolbar control", async () => {
    // `e2e/journey-board-cql.spec.ts` resolves the Issues toolbar button with
    // getByRole("button", { name: "Save as board" }), and Playwright matches an
    // accessible name by SUBSTRING — so "Save as board…" here would collide if
    // it carried the button role. Renaming the toolbar control once broke e2e
    // exactly this way.
    open(vi.fn());
    fireEvent.click(await screen.findByText("My open bugs"));
    const item = await screen.findByText(/save as board/i);
    expect(item.closest("[role=menuitem]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /save as board/i })).toBeNull();
  });

  it("omits it entirely for someone who cannot create boards", async () => {
    open(undefined);
    fireEvent.click(await screen.findByText("My open bugs"));
    // Positive control: the submenu really did open, so the absence below is
    // the action missing rather than the menu never rendering.
    expect(await screen.findByText("Run")).toBeTruthy();
    expect(screen.queryByText(/save as board/i)).toBeNull();
  });
});
