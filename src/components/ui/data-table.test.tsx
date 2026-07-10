// @vitest-environment jsdom
// COSMOS-26 — selecting a bulk-edit checkbox must NOT open the row's detail
// drawer. The selection cell's inner <div> already stopPropagation'd, but the
// cell (<td>) has padding AROUND the small 16px checkbox; clicking that padding
// — which a user aiming for the checkbox routinely does — bubbled to the row's
// onClick and popped the side drawer, interrupting the bulk-edit flow. The fix
// swallows clicks for the whole control cell, so these tests lock the contract:
// no drawer from the checkbox column, but the drawer still opens from content
// cells.
import { describe, it, expect, vi } from "vitest";
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
