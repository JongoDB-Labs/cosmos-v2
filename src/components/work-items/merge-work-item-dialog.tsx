"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * COSMOS-207: merge this item, a duplicate, into the one that survives. Says
 * plainly what will happen before it does, because it can't be undone in one
 * click: the work moves and this item is cancelled as merged.
 */
export function MergeWorkItemDialog({
  open,
  onClose,
  onConfirm,
  pending,
  sourceLabel,
  candidates,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (intoId: string) => void;
  pending: boolean;
  /** This item, as people know it, e.g. "ALPHA-7". */
  sourceLabel: string;
  candidates: { id: string; ticketNumber: number; title: string }[];
}) {
  const [intoId, setIntoId] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setIntoId(null);
          onClose();
        }
      }}
    >
      <DialogContent onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Merge {sourceLabel} into another item</DialogTitle>
          <DialogDescription>
            Pick the item that stays. It keeps its own details and fills any it&apos;s missing from{" "}
            {sourceLabel}.
          </DialogDescription>
        </DialogHeader>
        <SearchableSelect
          aria-label="Merge into"
          placeholder="Choose the item to keep…"
          searchPlaceholder="Search by number or title…"
          value={intoId}
          onValueChange={setIntoId}
          options={candidates.map((c) => ({ value: c.id, label: `#${c.ticketNumber} ${c.title}` }))}
        />
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          <li>Comments, logged time, sub-items, attachments and links move to it.</li>
          <li>Watchers and labels are added to it.</li>
          <li>
            {sourceLabel} is kept, marked Cancelled &middot; Merged, and linked to it, so searches
            still find it.
          </li>
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Keep both
          </Button>
          <Button onClick={() => intoId && onConfirm(intoId)} disabled={pending || !intoId}>
            {pending ? "Merging…" : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
