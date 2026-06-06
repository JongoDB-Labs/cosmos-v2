import {
  DataTableExample,
  DataTableWithExpansion,
  DataTableWithSelection,
} from "./data-table-example";

export const dataTableExamples = [
  {
    label: "Sortable table",
    node: <DataTableExample />,
    code: `const columns: ColumnDef<Row>[] = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "title", header: "Title" },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <Badge variant={row.original.status}>{row.original.status}</Badge>,
  },
];

<DataTable columns={columns} data={data} />`,
  },
  {
    label: "Expandable rows + pagination",
    node: <DataTableWithExpansion />,
    code: `<DataTable
  columns={columns}
  data={rows}
  renderExpanded={(row) => <div>{row.details}</div>}
  pagination={{ pageSize: 10 }}
/>`,
  },
  {
    label: "Row selection",
    node: <DataTableWithSelection />,
    code: `const [selection, setSelection] = useState<Record<string, boolean>>({});

<DataTable
  columns={columns}
  data={data}
  rowSelection={selection}
  onRowSelectionChange={setSelection}
/>`,
  },
];
