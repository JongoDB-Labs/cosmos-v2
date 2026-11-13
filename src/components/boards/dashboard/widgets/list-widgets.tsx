"use client";

/**
 * The list widgets: a grouped list, a checklist, an activity feed, and the
 * three sector registers built on them (incidents, RFIs, submittals).
 *
 * Each one reads only the board's widget bag, so it lists exactly the items the
 * board's own routes returned to this viewer and its filter bar left on screen.
 * The sector registers narrow that set further by the item's own work type or
 * custom field; they never reach past it.
 */
import { Check, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import { isWorkItemResolved } from "@/lib/work-items/done-state";
import type { WidgetProps } from "@/lib/boards/widget-registry";
import {
  groupRows,
  isClosedRow,
  rowStatusColumns,
  widgetGroupKey,
  widgetGroupLabel,
  widgetMaxItems,
  type WidgetItemRow,
} from "@/lib/boards/widget-data";
import { timeAgo } from "./activity-feed";
import {
  Caption,
  categoryToken,
  dayKey,
  formatDay,
  ItemTable,
  NoData,
  type ItemColumn,
} from "./widget-parts";

/** Most urgent first — the order the stock Priority panel uses. */
const PRIORITY_ORDER = ["Critical", "High", "Medium", "Low"] as const;

function dueCell(row: WidgetItemRow): string {
  return row.dueDate ? formatDay(dayKey(row.dueDate)) : "";
}

/** One item, on one line: key, title, and a trailing note. */
function ItemLine({ row, note }: { row: WidgetItemRow; note: string }) {
  return (
    <li className="flex items-center gap-2 px-1 py-1">
      <span className="shrink-0 font-mono text-muted-foreground">{row.key}</span>
      <span
        className={cn(
          "flex-1 truncate",
          isWorkItemResolved(row, rowStatusColumns(row)) && "text-muted-foreground line-through",
        )}
      >
        {row.title}
      </span>
      <span className="shrink-0 text-muted-foreground">{note}</span>
    </li>
  );
}

/**
 * Collapsible groups. `<details>`/`<summary>` rather than a hand-rolled
 * disclosure: it is keyboard-operable and announced as expandable with no
 * script, and a collapsed group keeps its count visible.
 */
function Groups({
  groups,
  limit,
  note,
}: {
  groups: Array<{ name: string; rows: WidgetItemRow[] }>;
  limit: number;
  note: (row: WidgetItemRow) => string;
}) {
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  // The cap is across ALL groups, in order: each group gets what the ones
  // before it left over.
  const before = groups.map((_, i) =>
    groups.slice(0, i).reduce((n, g) => n + g.rows.length, 0),
  );
  return (
    <div className="h-full overflow-auto text-xs" tabIndex={0}>
      {groups.map((g, i) => {
        const shown = g.rows.slice(0, Math.max(0, limit - before[i]));
        return (
          <details key={g.name} open className="mb-1">
            <summary className="cursor-pointer select-none rounded px-1 py-0.5 font-medium hover:bg-muted">
              {g.name}{" "}
              <span className="font-normal text-muted-foreground">({g.rows.length})</span>
            </summary>
            {shown.length > 0 && (
              <ul className="ml-2 divide-y border-l pl-1">
                {shown.map((r) => (
                  <ItemLine key={r.id} row={r} note={note(r)} />
                ))}
              </ul>
            )}
          </details>
        );
      })}
      {total > limit && (
        <p className="px-1 py-1 text-[11px] text-muted-foreground">
          Showing {limit} of {total}
        </p>
      )}
    </div>
  );
}

// ── grouped-list ─────────────────────────────────────────────────────────────

export function GroupedListWidget(props: WidgetProps) {
  const group = widgetGroupKey(props.config);
  const limit = widgetMaxItems(props.config, 25);
  if (!props.data) return <NoData />;
  if (props.data.rows.length === 0) return <NoData>No matching items</NoData>;
  const groups = groupRows(
    props.data.rows,
    group,
    group === "priority" ? PRIORITY_ORDER : [],
  );
  // The note repeats whatever the grouping is NOT, so a row still says
  // something its heading does not.
  const note = (r: WidgetItemRow) => (group === "status" ? r.assignee : r.status);
  return (
    <div className="flex h-full flex-col">
      <Caption>By {widgetGroupLabel(group).toLowerCase()}</Caption>
      <div className="min-h-0 flex-1">
        <Groups groups={groups} limit={limit} note={note} />
      </div>
    </div>
  );
}

// ── checklist ────────────────────────────────────────────────────────────────

export function ChecklistWidget(props: WidgetProps) {
  const limit = widgetMaxItems(props.config, 25);
  if (!props.data) return <NoData />;
  // Cancelled work is not a box anyone will tick, and counting it as "not
  // done" would make a finished list read as unfinished forever.
  const rows = props.data.rows.filter((r) => r.statusCategory !== "CANCELLED");
  if (rows.length === 0) return <NoData>No matching items</NoData>;
  // With cancelled rows gone, "resolved" is "done" — asked through the shared
  // rule so a tick here and a strike anywhere else cannot disagree.
  const ticked = (r: WidgetItemRow) => isWorkItemResolved(r, rowStatusColumns(r));
  const done = rows.filter(ticked).length;
  // Open first: the list is for the standup, and what is left is the point.
  const ordered = [...rows.filter((r) => !ticked(r)), ...rows.filter(ticked)];
  const shown = ordered.slice(0, limit);
  const pct = Math.round((done / rows.length) * 100);
  return (
    <div className="flex h-full flex-col text-xs">
      <div className="mb-1 flex shrink-0 items-center gap-2">
        <div
          role="progressbar"
          aria-label="Items done"
          aria-valuemin={0}
          aria-valuemax={rows.length}
          aria-valuenow={done}
          aria-valuetext={`${done} of ${rows.length} done`}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--border)]"
        >
          <div
            className="h-full rounded-full bg-[var(--status-done)]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="shrink-0 text-muted-foreground">
          {done} of {rows.length} done
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" tabIndex={0}>
        {/* Read-only ticks. Ticking a box here would have to move the item to
            a done column, and which one is the workflow's call — so the
            checklist reports status and the board's own controls change it. */}
        <ul className="divide-y">
          {shown.map((r) => {
            const isDone = ticked(r);
            return (
              <li key={r.id} className="flex items-center gap-2 px-1 py-1">
                {isDone ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-[var(--status-done)]" aria-hidden />
                ) : (
                  <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="sr-only">{isDone ? "Done:" : "Open:"}</span>
                <span className="shrink-0 font-mono text-muted-foreground">{r.key}</span>
                <span className={cn("flex-1 truncate", isDone && "text-muted-foreground line-through")}>
                  {r.title}
                </span>
              </li>
            );
          })}
        </ul>
        {ordered.length > shown.length && (
          <p className="px-1 py-1 text-[11px] text-muted-foreground">
            Showing {shown.length} of {ordered.length}
          </p>
        )}
      </div>
    </div>
  );
}

// ── activity-feed ────────────────────────────────────────────────────────────

export function ActivityFeedWidget(props: WidgetProps) {
  const limit = widgetMaxItems(props.config, 10);
  if (!props.data) return <NoData />;
  const rows = [...props.data.rows]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
  if (rows.length === 0) return <NoData>No recent activity</NoData>;
  return (
    <div className="h-full overflow-auto" tabIndex={0}>
      <ul className="divide-y text-xs">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-1 py-1.5">
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
              )}
              // The timeline's dot colours, so cancelled reads as neither open
              // work nor finished work.
              style={{ backgroundColor: categoryToken(r.statusCategory) }}
            />
            <span className="shrink-0 font-mono text-muted-foreground">{r.key}</span>
            <span className="flex-1 truncate">{r.title}</span>
            <span className="shrink-0 text-muted-foreground">{r.status}</span>
            <span className="w-14 shrink-0 text-right text-muted-foreground">
              {timeAgo(r.updatedAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── ops.incident-summary ─────────────────────────────────────────────────────

/** The ops sector's incident work type. */
export const INCIDENT_TYPE_KEY = "ops.incident";

export function IncidentSummaryWidget(props: WidgetProps) {
  const limit = widgetMaxItems(props.config, 25);
  if (!props.data) return <NoData />;
  const incidents = props.data.rows.filter((r) => r.typeKey === INCIDENT_TYPE_KEY);
  if (incidents.length === 0) {
    return <NoData>No incident work items on this board</NoData>;
  }
  const open = incidents.filter((r) => !isClosedRow(r));
  if (open.length === 0) return <NoData>No open incidents</NoData>;
  return (
    <div className="flex h-full flex-col">
      <Caption>
        {open.length} open of {incidents.length}, by priority
      </Caption>
      <div className="min-h-0 flex-1">
        <Groups
          groups={groupRows(open, "priority", PRIORITY_ORDER)}
          limit={limit}
          note={(r) => r.assignee}
        />
      </div>
    </div>
  );
}

// ── aec.rfi-tracker / aec.submittal-log ──────────────────────────────────────

/** The AEC sector's custom field keys these registers are keyed on. */
export const RFI_NUMBER_FIELD = "aec.rfi-number";
export const SUBMITTAL_STATUS_FIELD = "aec.submittal-status";

/** A custom field value as display text, or "" when it holds nothing. */
function fieldText(row: WidgetItemRow, key: string): string {
  const v = row.customFields[key];
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

const RFI_COLUMNS: ItemColumn[] = [
  { label: "RFI #", cell: (r) => fieldText(r, RFI_NUMBER_FIELD), className: "font-mono" },
  { label: "Subject", cell: (r) => r.title, className: "max-w-[16rem] truncate" },
  { label: "Status", cell: (r) => r.status },
  { label: "Assignee", cell: (r) => r.assignee },
  { label: "Due", cell: dueCell },
];

const SUBMITTAL_COLUMNS: ItemColumn[] = [
  { label: "Key", cell: (r) => r.key, className: "font-mono text-muted-foreground" },
  { label: "Description", cell: (r) => r.title, className: "max-w-[16rem] truncate" },
  { label: "Submittal", cell: (r) => capitalise(fieldText(r, SUBMITTAL_STATUS_FIELD)) },
  { label: "Status", cell: (r) => r.status },
  { label: "Due", cell: dueCell },
];

export function RfiTrackerWidget(props: WidgetProps) {
  const limit = widgetMaxItems(props.config, 25);
  if (!props.data) return <NoData />;
  const rows = props.data.rows.filter((r) => fieldText(r, RFI_NUMBER_FIELD) !== "");
  return (
    <ItemTable
      rows={rows}
      columns={RFI_COLUMNS}
      limit={limit}
      empty="No work items on this board have an RFI number"
    />
  );
}

export function SubmittalLogWidget(props: WidgetProps) {
  const limit = widgetMaxItems(props.config, 25);
  if (!props.data) return <NoData />;
  const rows = props.data.rows.filter(
    (r) => fieldText(r, SUBMITTAL_STATUS_FIELD) !== "",
  );
  return (
    <ItemTable
      rows={rows}
      columns={SUBMITTAL_COLUMNS}
      limit={limit}
      empty="No work items on this board have a submittal status"
    />
  );
}
