// @vitest-environment jsdom
// COSMOS-26 — selecting a bulk-edit checkbox must NOT open the row's detail
// drawer. The selection cell's inner <div> already stopPropagation'd, but the
// cell (<td>) has padding AROUND the small 16px checkbox; clicking that padding
// — which a user aiming for the checkbox routinely does — bubbled to the row's
// onClick and popped the side drawer, interrupting the bulk-edit flow. The fix
// swallows clicks for the whole control cell, so these tests lock the contract:
// no drawer from the checkbox column, but the drawer still opens from content
// cells.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { useState } from "react";
import { DataTable } from "./data-table";

interface Row {
  id: string;
  title: string;
}

const DATA: Row[] = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Beta" },
];

const COLUMNS: ColumnDef<Row>[] = [
  {
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => <span>{row.original.title}</span>,
  },
];

/** Renders the shared DataTable exactly as the Issues view does: a row-click
 *  drawer (onRowClick) plus externally-managed selection (checkbox column). */
function Harness({ onRowClick }: { onRowClick: (r: Row) => void }) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  return (
    <DataTable
      columns={COLUMNS}
      data={DATA}
      getRowId={(r) => r.id}
      onRowClick={onRowClick}
      rowSelection={rowSelection}
      onRowSelectionChange={setRowSelection}
    />
  );
}

describe("DataTable — bulk-select checkbox vs. row-click drawer (COSMOS-26)", () => {
  it("clicking a selection checkbox toggles it without opening the drawer", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<Harness onRowClick={onRowClick} />);

    const checkbox = screen.getAllByLabelText("Select row")[0] as HTMLInputElement;
    await user.click(checkbox);

    expect(checkbox.checked).toBe(true);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("clicking the checkbox CELL padding (not the input) does not open the drawer", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<Harness onRowClick={onRowClick} />);

    // The <td> around the small checkbox is the dead zone that used to bubble to
    // the row's onClick — clicking it must be a no-op for the drawer.
    const cell = screen.getAllByLabelText("Select row")[0].closest("td")!;
    await user.click(cell);

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("selecting several checkboxes in sequence never opens the drawer", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<Harness onRowClick={onRowClick} />);

    const boxes = screen.getAllByLabelText("Select row") as HTMLInputElement[];
    await user.click(boxes[0]);
    await user.click(boxes[1]);

    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(true);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("still opens the drawer when clicking the row's content cell", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<Harness onRowClick={onRowClick} />);

    await user.click(screen.getByText("Alpha"));

    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(DATA[0]);
  });
});

// COSMOS-28 — a view's page size must persist across sessions. With a persistKey,
// changing "Rows" writes the choice to localStorage and a remount recovers it;
// without one the size stays ephemeral (existing consumers unaffected).
describe("DataTable — persistent page size (COSMOS-28)", () => {
  const PERSIST_KEY = "cosmos:test-dt:page-size";
  const MANY: Row[] = Array.from({ length: 30 }, (_, i) => ({
    id: `r${i}`,
    title: `Row ${i}`,
  }));

  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("writes the chosen page size to storage and rehydrates it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <DataTable
        columns={COLUMNS}
        data={MANY}
        getRowId={(r) => r.id}
        pagination={{ pageSize: 10, pageSizeOptions: [10, 20, 50], persistKey: PERSIST_KEY }}
      />,
    );

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("10");

    await user.selectOptions(select, "20");
    expect(select.value).toBe("20");
    expect(window.localStorage.getItem(PERSIST_KEY)).toBe("20");

    // A fresh mount (new session) recovers the remembered choice after rehydrate.
    unmount();
    render(
      <DataTable
        columns={COLUMNS}
        data={MANY}
        getRowId={(r) => r.id}
        pagination={{ pageSize: 10, pageSizeOptions: [10, 20, 50], persistKey: PERSIST_KEY }}
      />,
    );
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("20");
  });

  it("does not persist when no persistKey is provided", async () => {
    const user = userEvent.setup();
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    render(
      <DataTable
        columns={COLUMNS}
        data={MANY}
        getRowId={(r) => r.id}
        pagination={{ pageSize: 10, pageSizeOptions: [10, 20, 50] }}
      />,
    );

    await user.selectOptions(screen.getByRole("combobox"), "20");
    // The select still reflects the choice for this session…
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("20");
    // …but nothing was written to storage.
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });
});
