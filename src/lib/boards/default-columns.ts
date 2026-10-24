import type { ColumnCategory } from "@prisma/client";

/**
 * The workflow a project gets when it is created without a template: by the
 * New project form and by the assistant's create_project tool alike, which kept
 * two copies of this list until COSMOS-206 added Cancelled to it.
 *
 * Cancelled (COSMOS-206) is its own status, separate from Done, so abandoned
 * work is neither reported as delivered nor deleted.
 */
export const CANCELLED_COLUMN = {
  name: "Cancelled",
  key: "cancelled",
  color: "#94a3b8",
  category: "CANCELLED" as const satisfies ColumnCategory,
};

export const DEFAULT_COLUMNS: {
  name: string;
  key: string;
  color: string;
  sortOrder: number;
  category: ColumnCategory;
}[] = [
  { name: "Backlog", key: "backlog", color: "#94a3b8", sortOrder: 0, category: "TODO" },
  { name: "To Do", key: "todo", color: "#60a5fa", sortOrder: 1, category: "TODO" },
  { name: "In Progress", key: "in-progress", color: "#fbbf24", sortOrder: 2, category: "IN_PROGRESS" },
  { name: "Review", key: "review", color: "#a78bfa", sortOrder: 3, category: "IN_PROGRESS" },
  { name: "Done", key: "done", color: "#34d399", sortOrder: 4, category: "DONE" },
  { ...CANCELLED_COLUMN, sortOrder: 5 },
];
