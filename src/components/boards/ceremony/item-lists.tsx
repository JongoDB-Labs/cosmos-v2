"use client";

import { AlertTriangle } from "lucide-react";
import type { CeremonyItem, CeremonyPayload } from "./use-ceremony";
import { highlightLabel, highlightStyle } from "@/lib/work-items/highlights";

/** "1 item" / "2 items". Read aloud in a ceremony, so it has to be grammatical. */
function itemCount(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

/** What shipped — heaviest first, the order an outbrief reads in. */
export function ShippedList({
  items,
  projectKey,
  totalPoints,
}: {
  items: CeremonyItem[];
  projectKey: string;
  totalPoints: number;
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)]">
        Nothing has reached a done column yet.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--text-muted)]">
        <span className="font-semibold text-[var(--text)]">{itemCount(items.length)}</span>{" "}
        · {totalPoints} story points
      </p>
      <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {items.map((i) => (
          <li
            key={i.id}
            data-highlight={i.highlight ?? undefined}
            style={highlightStyle(i.highlight)}
            title={highlightLabel(i.highlight) ?? undefined}
            className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-[var(--text-muted)]">
                {projectKey}-{i.ticketNumber}
              </p>
              <p className="truncate text-sm">{i.title}</p>
            </div>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface)] text-xs font-semibold tabular-nums ring-1 ring-[var(--border)]">
              {i.storyPoints ?? "–"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What carried forward.
 *
 * `unrecorded` is its own state, deliberately. Completing a sprint reassigns
 * unfinished items, so for sprints closed before we started recording which
 * ones moved, the set cannot be reconstructed. Rendering that as an empty list
 * would tell a room the sprint finished clean.
 */
export function CarriedList({
  carried,
  projectKey,
}: {
  carried: CeremonyPayload["carried"];
  projectKey: string;
}) {
  if (carried.kind === "unrecorded") {
    return (
      <div className="flex items-start gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-blocked-text,var(--status-blocked))]"
          aria-hidden
        />
        <div>
          <p className="text-sm font-medium">Carry-forward not recorded</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            This sprint completed before Cosmos began recording which items moved
            on. The items themselves now belong to a later sprint, so the set
            cannot be reconstructed — this is not a claim that nothing carried.
          </p>
        </div>
      </div>
    );
  }

  if (carried.items.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)]">
        Nothing carried forward — everything committed was finished.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--text-muted)]">
        <span className="font-semibold text-[var(--text)]">
          {itemCount(carried.items.length)}
        </span>{" "}
        {carried.items.length === 1 ? "rolls" : "roll"} into the next sprint
        {carried.kind === "live" ? " if the sprint closed now" : ""}
      </p>
      <ul className="grid gap-2 md:grid-cols-2">
        {carried.items.map((i) => (
          <li
            key={i.id}
            data-highlight={i.highlight ?? undefined}
            style={highlightStyle(i.highlight)}
            title={highlightLabel(i.highlight) ?? undefined}
            className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-[var(--text-muted)]">
                {projectKey}-{i.ticketNumber}
              </p>
              <p className="truncate text-sm">{i.title}</p>
            </div>
            <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
              {i.statusLabel ?? i.columnKey}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
