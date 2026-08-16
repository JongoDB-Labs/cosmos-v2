"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ParentCascade {
  parentId: string;
  parentTitle: string;
  parentColumnName: string;
  childTitle: string;
  /** The column the child was dropped into — where the parent would go. */
  targetColumnKey: string;
  targetColumnName: string;
}

/**
 * Offer to move a parent forward when one of its children has overtaken it.
 *
 * Nothing prevents a child from moving ahead of its parent, and nothing should:
 * a parent finishes when its children do. But a child in In Progress under a
 * parent still in Backlog makes the parent misreport the state of the work, and
 * the only fix today is to remember to go and move it by hand.
 *
 * So this prompts and never enforces. The child's own move is already saved by
 * the time it opens; dismissing it leaves the parent exactly where it was.
 */
export function ParentCascadeDialog({
  cascade,
  onClose,
  onConfirm,
}: {
  cascade: ParentCascade | null;
  onClose: () => void;
  onConfirm: (parentId: string, targetColumnKey: string) => void;
}) {
  // Mounted always, `open` toggled — see actual-date-dialog: base-ui's Root
  // wants the false -> true transition, and mounting already-open renders nothing.
  return (
    <Dialog open={cascade != null} onOpenChange={(o) => !o && onClose()}>
      {cascade && (
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move the parent too?</DialogTitle>
          <DialogDescription>
            <span className="font-medium">{cascade.childTitle}</span> is now in{" "}
            <span className="font-medium">{cascade.targetColumnName}</span>, but its parent{" "}
            <span className="font-medium">{cascade.parentTitle}</span> is still in{" "}
            <span className="font-medium">{cascade.parentColumnName}</span>. Move the parent
            to {cascade.targetColumnName} as well?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Leave the parent
          </Button>
          <Button
            onClick={() => {
              onConfirm(cascade.parentId, cascade.targetColumnKey);
              onClose();
            }}
          >
            Move parent to {cascade.targetColumnName}
          </Button>
        </DialogFooter>
      </DialogContent>
      )}
    </Dialog>
  );
}
