// @vitest-environment jsdom
//
// Covers the two things this wrapper exists to get right. Both are silent
// failures if broken — the sheet still renders, it just shows or leaves behind
// the wrong data.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkItem } from "@/types/models";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/projects/ENG" }));

type SheetProps = {
  open: boolean;
  item: WorkItem | null;
  onUpdate: (u: WorkItem) => void;
  onDelete?: (id: string) => void;
};
let sheetProps: SheetProps | null = null;
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: (props: SheetProps) => {
    sheetProps = props;
    return props.open ? <div data-testid="sheet">{props.item?.title}</div> : null;
  },
}));

const jsonFetchMock = vi.fn();
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: (...args: unknown[]) => jsonFetchMock(...args),
}));

import { BoardItemDetailSheet } from "@/components/work-items/board-item-detail-sheet";

const FULL_ITEM = { id: "W1", title: "Saved title", ticketNumber: 7 } as WorkItem;

function setup(itemId: string | null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // What the board itself renders from. The wrapper must keep this in step.
  qc.setQueryData(
    ["org", "acme", "work-items", "proj"],
    [{ id: "W1", title: "Stale title" }, { id: "W2", title: "Other" }],
  );
  const ui = render(
    <QueryClientProvider client={qc}>
      <BoardItemDetailSheet
        itemId={itemId}
        onOpenChange={() => {}}
        orgId="org"
        projectId="proj"
        boardId="board"
      />
    </QueryClientProvider>,
  );
  return { qc, ...ui };
}

function boardRows(qc: QueryClient) {
  return qc.getQueryData<WorkItem[]>(["org", "acme", "work-items", "proj"]);
}

afterEach(() => {
  cleanup();
  sheetProps = null;
  jsonFetchMock.mockReset();
});

describe("BoardItemDetailSheet", () => {
  it("stays closed until the FULL item has loaded", async () => {
    // The board only has a light row for W1; the sheet must not open against it.
    let resolveItem: (v: WorkItem) => void = () => {};
    jsonFetchMock.mockImplementation((url: string) =>
      url.endsWith("/work-items/W1")
        ? new Promise<WorkItem>((r) => {
            resolveItem = r;
          })
        : Promise.resolve([]),
    );

    setup("W1");

    // In flight: the sheet seeds its form once per item id, so opening now
    // would leave the user editing a half-populated ticket.
    expect(screen.queryByTestId("sheet")).toBeNull();

    await act(async () => {
      resolveItem(FULL_ITEM);
    });
    await waitFor(() => expect(screen.getByTestId("sheet")).toBeTruthy());
    expect(screen.getByTestId("sheet").textContent).toBe("Saved title");
  });

  it("writes a save back into the list the board renders from", async () => {
    jsonFetchMock.mockImplementation((url: string) =>
      url.endsWith("/work-items/W1")
        ? Promise.resolve(FULL_ITEM)
        : Promise.resolve([]),
    );

    const { qc } = setup("W1");
    await waitFor(() => expect(screen.getByTestId("sheet")).toBeTruthy());

    act(() => {
      sheetProps!.onUpdate({ ...FULL_ITEM, title: "Renamed" });
    });

    expect(
      boardRows(qc)?.find((i) => i.id === "W1")?.title,
      "the card behind the sheet must not keep showing the pre-edit title",
    ).toBe("Renamed");
    // Untouched rows stay untouched.
    expect(boardRows(qc)?.find((i) => i.id === "W2")?.title).toBe("Other");
  });

  it("drops a deleted item from the board's list", async () => {
    jsonFetchMock.mockImplementation((url: string) =>
      url.endsWith("/work-items/W1")
        ? Promise.resolve(FULL_ITEM)
        : Promise.resolve([]),
    );

    const { qc } = setup("W1");
    await waitFor(() => expect(screen.getByTestId("sheet")).toBeTruthy());

    act(() => {
      sheetProps!.onDelete?.("W1");
    });

    expect(boardRows(qc)?.map((i) => i.id)).toEqual(["W2"]);
  });

  it("fetches nothing until an item is actually clicked", () => {
    setup(null);
    expect(jsonFetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sheet")).toBeNull();
  });
});
