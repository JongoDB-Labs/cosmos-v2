"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";
import type { KeyResult } from "@/types/models";

export const RAG_META = {
  GREEN: { label: "On track", dot: "bg-green-500", ring: "ring-green-500", text: "text-green-600" },
  YELLOW: { label: "At risk", dot: "bg-yellow-500", ring: "ring-yellow-500", text: "text-yellow-600" },
  RED: { label: "Behind", dot: "bg-red-500", ring: "ring-red-500", text: "text-red-600" },
} as const;

type Rag = keyof typeof RAG_META;

/**
 * Record a point-in-time check-in on a key result: value + stoplight health +
 * confidence + note/blockers. Posts to the KR's /checkins endpoint (which also
 * folds the snapshot back onto the KR and re-rolls objective progress), then
 * calls onDone() so the board refetches.
 */
export function KeyResultCheckinDialog({
  orgId,
  projectId,
  keyResult,
  open,
  onOpenChange,
  onDone,
}: {
  orgId: string;
  projectId: string;
  keyResult: KeyResult;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(String(keyResult.currentValue));
  const [confidence, setConfidence] = useState(keyResult.confidence ?? 70);
  const [rag, setRag] = useState<Rag>(keyResult.rag ?? "GREEN");
  const [note, setNote] = useState("");
  const [blockers, setBlockers] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    const num = parseFloat(value);
    if (isNaN(num)) {
      toast.error("Enter a numeric value.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/key-results/${keyResult.id}/checkins`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            value: num,
            confidence,
            rag,
            note: note.trim() || null,
            blockers: blockers.trim() || null,
          }),
        },
      );
      if (!res.ok) throw new Error("Check-in failed");
      toast.success("Checked in");
      onOpenChange(false);
      onDone();
    } catch (e) {
      notifyError(e, "Couldn't record the check-in.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Check in · {keyResult.title}</DialogTitle>
          <DialogDescription>Where does this key result stand right now?</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Current value{keyResult.unit ? ` (${keyResult.unit})` : ""}</Label>
            <Input value={value} onChange={(e) => setValue(e.target.value)} className="mt-1" />
          </div>

          <div>
            <Label>Health</Label>
            <div className="mt-1 flex gap-2">
              {(Object.keys(RAG_META) as Rag[]).map((k) => {
                const m = RAG_META[k];
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setRag(k)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
                      rag === k
                        ? `border-transparent ring-2 ${m.ring}`
                        : "border-[var(--border)] text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span className={cn("size-2.5 rounded-full", m.dot)} /> {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <Label>
              Confidence: <span className="font-mono">{confidence}%</span>
            </Label>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
              className="mt-1 w-full accent-[var(--primary)]"
            />
          </div>

          <div>
            <Label>Note (optional)</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="mt-1"
              placeholder="What moved, what's next…"
            />
          </div>

          <div>
            <Label>Blockers (optional)</Label>
            <Textarea
              value={blockers}
              onChange={(e) => setBlockers(e.target.value)}
              rows={2}
              className="mt-1"
              placeholder="What's in the way / help needed…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Check in"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
