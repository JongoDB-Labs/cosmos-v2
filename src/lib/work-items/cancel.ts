/**
 * COSMOS-206: cancelling work, with a reason. A release train cancels stories
 * that were overcome by events, and wants to say so instead of leaving them in
 * Done (which reports them as delivered) or deleting them (which loses them).
 *
 * Duplicates are deliberately NOT a reason here: cancelling one copy could hide
 * work tracked on it, so duplicates are merged instead.
 */
export type CancelReason = "OBE" | "OTHER";

export const CANCEL_REASONS: { value: CancelReason; label: string; hint: string }[] = [
  {
    value: "OBE",
    label: "Overcome by events (OBE)",
    hint: "The need went away: plans changed, or it was solved another way.",
  },
  { value: "OTHER", label: "Other", hint: "Say why in the note." },
];

export const CANCEL_NOTE_MAX = 500;

export const CANCEL_NOTE_REQUIRED_MESSAGE = "Add a note saying why it was cancelled.";

export function cancelReasonLabel(reason: string | null | undefined): string | null {
  return CANCEL_REASONS.find((r) => r.value === reason)?.label ?? null;
}

/** "Other" means nothing without a note; OBE is self-explanatory. */
export function cancelInputError(reason: CancelReason, note: string | null | undefined): string | null {
  if (reason === "OTHER" && !note?.trim()) return CANCEL_NOTE_REQUIRED_MESSAGE;
  return null;
}

/**
 * What a status change does to an item's reason. A cancel records it (the
 * note trimmed, blank stored as null). A move anywhere that isn't a Cancelled
 * status clears a reason left over from an earlier cancel. Anything else
 * leaves it alone: `undefined` means "don't write these fields".
 */
export function cancelFieldsForUpdate(args: {
  requested: { reason?: CancelReason; note?: string | null };
  columnChanged: boolean;
  destIsCancelled: boolean;
  existing: { reason: CancelReason | null; note: string | null };
}): { cancelReason: CancelReason | null; cancelNote: string | null } | undefined {
  if (args.requested.reason) {
    return { cancelReason: args.requested.reason, cancelNote: args.requested.note?.trim() || null };
  }
  if (args.columnChanged && !args.destIsCancelled && (args.existing.reason || args.existing.note)) {
    return { cancelReason: null, cancelNote: null };
  }
  return undefined;
}
