import { toCSV } from "@/lib/export/csv";
import { billedHoursOf } from "@/lib/time/billed-hours";
import { dateOnlyKey } from "@/lib/time/date-only";

/**
 * A time-entry export a person can hand to someone else: names, not ids, and
 * the same column order whether or not the first row happens to have a CLIN.
 * Built from the entries Time Tracking already loaded, so it can never show
 * more than the viewer was allowed to read.
 */
export interface ExportableTimeEntry {
  date: string;
  hours: number;
  billedHours: number | null;
  projectId: string | null;
  clinId: string | null;
  description: string;
  billableType: "BILLABLE" | "NON_BILLABLE" | "INTERNAL";
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
  tags: string[];
}

const BILLABLE: Record<ExportableTimeEntry["billableType"], string> = {
  BILLABLE: "Billable",
  NON_BILLABLE: "Non-billable",
  INTERNAL: "Internal",
};

const STATUS: Record<ExportableTimeEntry["status"], string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export const TIME_CSV_COLUMNS = [
  "Date",
  "Hours",
  "Billed hours",
  "Project",
  "CLIN",
  "Description",
  "Billable",
  "Status",
  "Tags",
] as const;

export function timeEntriesToCsv(
  entries: readonly ExportableTimeEntry[],
  names: {
    project: (id: string) => string | undefined;
    clin: (id: string) => string | undefined;
  },
): string {
  const header = TIME_CSV_COLUMNS.join(",");
  if (entries.length === 0) return header;
  const rows = [...entries]
    .sort((a, b) => dateOnlyKey(a.date).localeCompare(dateOnlyKey(b.date)))
    .map((e) => ({
      Date: dateOnlyKey(e.date),
      Hours: e.hours,
      "Billed hours": billedHoursOf(e),
      Project: e.projectId ? (names.project(e.projectId) ?? "") : "",
      CLIN: e.clinId ? (names.clin(e.clinId) ?? "") : "",
      Description: e.description,
      Billable: BILLABLE[e.billableType],
      Status: STATUS[e.status],
      Tags: e.tags.join("; "),
    }));
  return toCSV(rows);
}

/** `time-<who>-<range>.csv`, kept to characters every filesystem accepts. */
export function timeCsvFilename(who: string, range: string): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  return `time-${slug(who)}-${slug(range)}.csv`;
}
