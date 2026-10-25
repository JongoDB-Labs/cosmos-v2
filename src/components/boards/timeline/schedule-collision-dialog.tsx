"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const span = (r: { start: Date; end: Date }) => `${day.format(r.start)} to ${day.format(r.end)}`;

export interface CollisionRow {
  id: string;
  label: string;
  start: Date;
  end: Date;
  later: { start: Date; end: Date };
  earlier: { start: Date; end: Date };
}

/**
 * Asked when a drop lands on a sibling's dates (see schedule-collisions.ts).
 * Nothing is saved until a choice is made, and Cancel (or Escape) puts the bar
 * back. Generic: any Gantt with sibling bars can mount it, a plugin's included.
 */
export function ScheduleCollisionDialog({
  open,
  movedLabel,
  collisions,
  onParallel,
  onPushLater,
  onPushEarlier,
  onCancel,
}: {
  open: boolean;
  /** How the dropped item is named, e.g. "FSC-4, Design". */
  movedLabel: string;
  collisions: CollisionRow[];
  onParallel: () => void;
  onPushLater: () => void;
  onPushEarlier: () => void;
  onCancel: () => void;
}) {
  const one = collisions.length === 1;
  const them = one ? "it" : "them";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Overlaps {one ? "another item" : `${collisions.length} other items`}</DialogTitle>
          <DialogDescription>
            {movedLabel} now overlaps {one ? "a sibling" : "siblings"} under the same parent. Run them in
            parallel, or move {them} out of the way.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm" aria-label="Overlapping items">
          {collisions.map((c) => (
            <li key={c.id} className="rounded-md border border-border p-2">
              <div className="font-medium">{c.label}</div>
              <div className="text-muted-foreground">Now {span(c)}</div>
              <div className="text-muted-foreground">If pushed later: {span(c.later)}</div>
              <div className="text-muted-foreground">If pushed earlier: {span(c.earlier)}</div>
            </li>
          ))}
        </ul>
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={onPushEarlier}>
            Push {them} earlier
          </Button>
          <Button variant="outline" onClick={onPushLater}>
            Push {them} later
          </Button>
          <Button onClick={onParallel}>Run in parallel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
