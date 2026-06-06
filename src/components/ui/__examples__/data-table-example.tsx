"use client";
import { useState } from "react";
import { DataTable } from "../data-table";
import { Badge } from "../badge";
import type { ColumnDef } from "@tanstack/react-table";

type Row = {
  id: string;
  title: string;
  status: string;
  owner: string;
  details?: string;
};

const data: Row[] = [
  {
    id: "FSC-1",
    title: "Set up auth",
    status: "review",
    owner: "Jon",
    details:
      "Google OAuth wired with offline access; refresh token captured on first consent.",
  },
  {
    id: "FSC-2",
    title: "Build onboarding",
    status: "done",
    owner: "Jon",
    details:
      "Form with name + slug; POSTs to /api/v1/orgs; confetti on success.",
  },
  {
    id: "FSC-3",
    title: "Fix sidebar logo",
    status: "progress",
    owner: "Jon",
    details: "Swapped cosmic SVG for FSC PNG logo via next/image.",
  },
  {
    id: "FSC-4",
    title: "Migrate to RQ",
    status: "done",
    owner: "Sara",
    details: "",
  },
  {
    id: "FSC-5",
    title: "Suspense streaming",
    status: "done",
    owner: "Mike",
    details: "",
  },
];

const columns: ColumnDef<Row>[] = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "title", header: "Title" },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant={row.original.status as "progress" | "review" | "done"}>
        {row.original.status}
      </Badge>
    ),
  },
  { accessorKey: "owner", header: "Owner" },
];

export function DataTableExample() {
  return <DataTable columns={columns} data={data.slice(0, 3)} />;
}

export function DataTableWithExpansion() {
  return (
    <DataTable
      columns={columns}
      data={data}
      renderExpanded={(row) => (
        <div className="text-sm text-[var(--text-muted)]">
          <p className="mb-1 font-medium text-[var(--text)]">Details</p>
          <p>{row.details || "No additional notes."}</p>
        </div>
      )}
      pagination={{ pageSize: 3, pageSizeOptions: [3, 5, 10] }}
    />
  );
}

export function DataTableWithSelection() {
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const selectedCount = Object.keys(selection).filter((k) => selection[k]).length;

  return (
    <div>
      {selectedCount > 0 && (
        <div className="mb-2 text-xs text-[var(--text-muted)]">
          {selectedCount} selected
        </div>
      )}
      <DataTable
        columns={columns}
        data={data}
        rowSelection={selection}
        onRowSelectionChange={setSelection}
      />
    </div>
  );
}
