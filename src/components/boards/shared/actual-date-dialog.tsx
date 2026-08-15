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

/** Which actual date a move just captured. */
export type CapturedDateField = "actualStart" | "completedAt";

export interface ActualDateCapture {
  itemId: string;
  itemTitle: string;
  field: CapturedDateField;
  /** What the server stamped — an ISO instant, normally "now". */
  capturedIso: string;
  /** The column the card was dropped into, for the prompt's wording. */
  columnName: string;
}

/** `yyyy-mm-dd` in UTC, matching how the rest of the app pins dates. */
function toDateInput(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Offer to correct the actual start / end a board move just stamped.
 *
 * Moving a card into an In Progress or Done column records that date as NOW,
 * which is right when the move is same-day and wrong the rest of the time —
 * teams routinely update a board days after the work happened. A user who moved
 * a batch of already-underway tickets had every Gantt bar jump to that afternoon
 * with no way to correct it, which is the report this exists to answer.
 *
 * Deliberately NON-BLOCKING: the move has already been saved by the time this
 * opens. Dismissing it keeps the captured date, so the dialog can never strand a
 * card mid-move or undo work the user asked for. It only ever refines a date.
 */
export function ActualDateDialog({
  capture,
  onClose,
  onConfirm,
}: {
  capture: ActualDateCapture | null;
  onClose: () => void;
  /** Called only when the user picks a DIFFERENT date. */
  onConfirm: (itemId: string, field: CapturedDateField, iso: string) => void;
}) {
  if (!capture) return null;
  // Keyed so a new capture REMOUNTS the body and its state initialises from that
  // card's date. Re-seeding through an effect instead would schedule a cascading
  // render, which `react-hooks/set-state-in-effect` rejects — and would briefly
  // show the previous card's date.
  return (
    <Body
      key={`${capture.itemId}-${capture.field}`}
      capture={capture}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

function Body({
  capture,
  onClose,
  onConfirm,
}: {
  capture: ActualDateCapture;
  onClose: () => void;
  onConfirm: (itemId: string, field: CapturedDateField, iso: string) => void;
}) {
  const [value, setValue] = useState(() => toDateInput(capture.capturedIso));

  const isStart = capture.field === "actualStart";
  const noun = isStart ? "start" : "completion";
  const captured = toDateInput(capture.capturedIso);
  const changed = value !== "" && value !== captured;

  function save() {
    if (!changed) {
      onClose();
      return;
    }
    // Midday UTC, the same convention the seeds and importer use, so a date
    // never lands on the wrong calendar day for a reader behind UTC.
    onConfirm(capture.itemId, capture.field, new Date(`${value}T12:00:00.000Z`).toISOString());
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isStart ? "When did this work start?" : "When was this finished?"}
          </DialogTitle>
          <DialogDescription>
            Moving <span className="font-medium">{capture.itemTitle}</span> to{" "}
            <span className="font-medium">{capture.columnName}</span> recorded its actual{" "}
            {noun} as today. If the work actually {isStart ? "began" : "finished"} on
            another day, set it here — the timeline draws from this date.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5 py-2">
          <label htmlFor="actual-date" className="text-sm font-medium">
            Actual {noun} date
          </label>
          <Input
            id="actual-date"
            type="date"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep today
          </Button>
          <Button onClick={save} disabled={!value}>
            {changed ? `Set ${noun} date` : "Done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
