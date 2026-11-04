"use client";

import { useCallback, useRef, useState } from "react";
import { FetchError } from "@/lib/query/json-fetcher";
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

/** Did the server refuse this close for want of a file or a reason? */
export function needsCloseEvidence(e: unknown): boolean {
  return e instanceof FetchError && (e.body as { code?: unknown } | null)?.code === "close_evidence_required";
}

/**
 * The closing rule's prompt (src/lib/pm/closing-evidence.ts), for records that
 * close outside the workflow engine.
 *
 * `withEvidence(send)` runs `send({})`. If the server answers
 * close_evidence_required, it asks why no supporting file is needed and runs
 * `send({ closeEvidenceNote })` with the answer; a person who cancels gets the
 * original refusal back, so the caller's own error handling still runs.
 */
export function useCloseEvidencePrompt() {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const pending = useRef<{ resolve: (note: string | null) => void } | null>(null);

  const ask = () =>
    new Promise<string | null>((resolve) => {
      pending.current = { resolve };
      setNote("");
      setOpen(true);
    });

  const finish = (value: string | null) => {
    setOpen(false);
    pending.current?.resolve(value);
    pending.current = null;
  };

  const withEvidence = useCallback(
    async <T,>(send: (extra: { closeEvidenceNote?: string }) => Promise<T>): Promise<T> => {
      try {
        return await send({});
      } catch (e) {
        if (!needsCloseEvidence(e)) throw e;
        const reason = await ask();
        if (!reason) throw e;
        return send({ closeEvidenceNote: reason });
      }
    },
    [],
  );

  const dialog = (
    <Dialog open={open} onOpenChange={(o) => !o && finish(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Why no supporting file is needed</DialogTitle>
          <DialogDescription>
            Closing this needs a supporting file attached, or a recorded reason one isn&apos;t needed.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Reason no file is needed"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Accepted verbally at the review meeting"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button disabled={!note.trim()} onClick={() => finish(note.trim())}>
            Record and close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { withEvidence, dialog };
}
