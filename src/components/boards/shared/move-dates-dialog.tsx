"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** The four dates the Gantt draws from. Empty string means "not set". */
export interface MoveDates {
  startDate: string;
  dueDate: string;
  actualStart: string;
  completedAt: string;
}

export interface MoveDatesPrompt {
  itemId: string;
  itemTitle: string;
  /** The column the card was dropped into, for the prompt's wording. */
  columnName: string;
  /** Whether that column starts work or finishes it. */
  phase: "started" | "finished";
  /** Current values, as ISO instants or null. */
  current: {
    startDate: string | null;
    dueDate: string | null;
    actualStart: string | null;
    completedAt: string | null;
  };
}

/** `yyyy-mm-dd` in UTC, matching how the rest of the app pins dates. */
function toDateInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

/** Midday UTC, the convention the seeds and importer use, so a date never lands
 *  on the wrong calendar day for a reader behind UTC. */
function toIso(value: string): string | null {
  return value ? new Date(`${value}T12:00:00.000Z`).toISOString() : null;
}

/**
 * Confirm the dates behind a board move, all four of them.
 *
 * Moving a card into an In Progress or Done column stamps the matching ACTUAL
 * date as today — right when the move is same-day, wrong the rest of the time,
 * because teams routinely update a board days after the work happened.
 *
 * It used to offer only the one field the server had just stamped, which meant
 * the moment a user was already thinking about this ticket's dates was also the
 * one moment they could not fix the others. The plan and the actuals are read
 * together on the timeline, so they are edited together here.
 *
 * Deliberately NON-BLOCKING: the move is already saved by the time this opens.
 * Dismissing keeps whatever the server stamped, so the dialog can never strand a
 * card mid-move or undo work the user asked for.
 */
export function MoveDatesDialog({
  prompt,
  onClose,
  onConfirm,
}: {
  prompt: MoveDatesPrompt | null;
  onClose: () => void;
  /** Called only with the fields that actually changed. */
  onConfirm: (itemId: string, changes: Partial<Record<keyof MoveDates, string | null>>) => void;
}) {
  // Mounted always, `open` toggled — the pattern every other dialog here uses.
  // Mounting it already-open never rendered: base-ui's Root wants the
  // false -> true transition, so the popup stayed closed and the prompt was
  // silently lost even though the state behind it was correct.
  //
  // Keyed so a new prompt REMOUNTS the body and its state initialises from that
  // card's dates, rather than re-seeding through an effect (which would schedule
  // a cascading render and briefly show the previous card's values).
  return (
    <Dialog open={prompt != null} onOpenChange={(o) => !o && onClose()}>
      {prompt && (
        <Body key={prompt.itemId} prompt={prompt} onClose={onClose} onConfirm={onConfirm} />
      )}
    </Dialog>
  );
}

const FIELDS: Array<{ key: keyof MoveDates; label: string; hint: string }> = [
  { key: "startDate", label: "Planned start", hint: "When it was meant to begin" },
  { key: "dueDate", label: "Planned end", hint: "When it was meant to finish" },
  { key: "actualStart", label: "Actual start", hint: "When it really began" },
  { key: "completedAt", label: "Actual end", hint: "When it really finished" },
];

function Body({
  prompt,
  onClose,
  onConfirm,
}: {
  prompt: MoveDatesPrompt;
  onClose: () => void;
  onConfirm: (itemId: string, changes: Partial<Record<keyof MoveDates, string | null>>) => void;
}) {
  const initial: MoveDates = {
    startDate: toDateInput(prompt.current.startDate),
    dueDate: toDateInput(prompt.current.dueDate),
    actualStart: toDateInput(prompt.current.actualStart),
    completedAt: toDateInput(prompt.current.completedAt),
  };
  const [values, setValues] = useState<MoveDates>(initial);

  const changed = FIELDS.filter((f) => values[f.key] !== initial[f.key]);
  // The plan cannot end before it starts, and neither can the work. Caught here
  // rather than on save so the button explains itself before it is pressed.
  const plannedBackwards =
    values.startDate !== "" && values.dueDate !== "" && values.dueDate < values.startDate;
  const actualBackwards =
    values.actualStart !== "" && values.completedAt !== "" && values.completedAt < values.actualStart;
  const invalid = plannedBackwards || actualBackwards;

  function save() {
    if (changed.length === 0 || invalid) {
      onClose();
      return;
    }
    const patch: Partial<Record<keyof MoveDates, string | null>> = {};
    for (const f of changed) patch[f.key] = toIso(values[f.key]);
    onConfirm(prompt.itemId, patch);
    onClose();
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {prompt.phase === "started" ? "Check the dates for this work" : "Check the dates before closing this"}
        </DialogTitle>
        <DialogDescription>
          Moving <span className="font-medium">{prompt.itemTitle}</span> to{" "}
          <span className="font-medium">{prompt.columnName}</span> recorded its actual{" "}
          {prompt.phase === "started" ? "start" : "end"} as today. Correct anything that is
          wrong — the timeline draws its bars from the actuals and its shadows from the plan.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-1 gap-3 py-2 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <label htmlFor={`move-date-${f.key}`} className="text-sm font-medium">
              {f.label}
            </label>
            <Input
              id={`move-date-${f.key}`}
              type="date"
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
            <span className="text-xs text-muted-foreground">{f.hint}</span>
          </div>
        ))}
      </div>

      {invalid && (
        <p role="alert" className="text-sm text-[var(--status-critical)]">
          {plannedBackwards
            ? "Planned end is before planned start."
            : "Actual end is before actual start."}
        </p>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Leave as is
        </Button>
        <Button onClick={save} disabled={invalid}>
          {changed.length > 0 ? "Save dates" : "Done"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
