"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  CANCEL_NOTE_MAX,
  CANCEL_REASONS,
  cancelInputError,
  type CancelReason,
} from "@/lib/work-items/cancel";

/**
 * COSMOS-206: say why work is being cancelled. OBE (overcome by events) or
 * Other with a note. Duplicates are merged rather than cancelled, so they are
 * not offered. Reopened with the current reason to edit it.
 */
export function CancelWorkItemDialog({
  open,
  onClose,
  onConfirm,
  pending,
  initialReason,
  initialNote,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: CancelReason, note: string) => void;
  pending: boolean;
  initialReason?: CancelReason | null;
  initialNote?: string | null;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* Keyed on open so each opening starts from the item's current reason. */}
      {open && (
        <CancelForm
          onClose={onClose}
          onConfirm={onConfirm}
          pending={pending}
          initialReason={initialReason ?? "OBE"}
          initialNote={initialNote ?? ""}
          editing={Boolean(initialReason)}
        />
      )}
    </Dialog>
  );
}

function CancelForm({
  onClose,
  onConfirm,
  pending,
  initialReason,
  initialNote,
  editing,
}: {
  onClose: () => void;
  onConfirm: (reason: CancelReason, note: string) => void;
  pending: boolean;
  initialReason: CancelReason;
  initialNote: string;
  editing: boolean;
}) {
  const [reason, setReason] = useState<CancelReason>(initialReason);
  const [note, setNote] = useState(initialNote);
  const error = cancelInputError(reason, note);

  return (
    <DialogContent onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <DialogHeader>
        <DialogTitle>{editing ? "Why was this cancelled?" : "Cancel this work?"}</DialogTitle>
        <DialogDescription>
          It moves to Cancelled: kept and searchable, but not counted as delivered.
        </DialogDescription>
      </DialogHeader>
      <div role="radiogroup" aria-label="Reason" className="space-y-2">
        {CANCEL_REASONS.map((r) => (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={reason === r.value}
            onClick={() => setReason(r.value)}
            className={cn(
              "w-full rounded-md border px-3 py-2 text-left text-sm",
              reason === r.value ? "border-primary bg-muted" : "border-border hover:bg-muted",
            )}
          >
            <span className="font-medium">{r.label}</span>
            <span className="block text-xs text-muted-foreground">{r.hint}</span>
          </button>
        ))}
      </div>
      <div className="space-y-1">
        <label htmlFor="cancel-note" className="text-xs font-medium">
          Note{reason === "OTHER" ? " *" : " (optional)"}
        </label>
        <Textarea
          id="cancel-note"
          value={note}
          maxLength={CANCEL_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            reason === "OTHER" ? "Why was it cancelled?" : "e.g. Replaced by the new onboarding flow"
          }
          aria-required={reason === "OTHER"}
        />
        {reason === "OTHER" && error && (
          <p className="text-xs text-muted-foreground">{error}</p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={pending}>
          {editing ? "Close" : "Keep it"}
        </Button>
        <Button onClick={() => onConfirm(reason, note.trim())} disabled={pending || Boolean(error)}>
          {pending ? "Saving…" : editing ? "Save reason" : "Mark cancelled"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
