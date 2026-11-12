"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { notifyError } from "@/lib/errors/notify";
import { KR_DEFAULT_TARGET, krProgressPercent } from "@/lib/okr/progress";
import type { KeyResult } from "@/types/models";

interface KeyResultEditDialogProps {
  orgId: string;
  projectId: string;
  keyResult: KeyResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save so the board refetches (progress + RAG roll-up). */
  onSaved: () => void;
}

export function KeyResultEditDialog({
  orgId,
  projectId,
  keyResult,
  open,
  onOpenChange,
  onSaved,
}: KeyResultEditDialogProps) {
  const [title, setTitle] = useState(keyResult.title);
  const [startValue, setStartValue] = useState(String(keyResult.startValue));
  const [currentValue, setCurrentValue] = useState(String(keyResult.currentValue));
  const [targetValue, setTargetValue] = useState(String(keyResult.targetValue));
  // A key result counting linked tickets uses their number as its target until
  // someone sets one (lib/okr/progress). The field shows that number; saving
  // must not store it as if it had been typed, or the target would stop
  // following the links. Typing a number sets a target; the button undoes it.
  const linkedTotal = keyResult.linkedTotal ?? 0;
  const [targetFromLinks, setTargetFromLinks] = useState(!!keyResult.targetFromLinks);
  const [unit, setUnit] = useState(keyResult.unit);
  const [lowerIsBetter, setLowerIsBetter] = useState(keyResult.lowerIsBetter);
  const [saving, setSaving] = useState(false);

  // The fields seed once from props (useState initializers). The parent mounts
  // this dialog only while open, so each open re-seeds from the KR's live values
  // — no re-seeding effect needed (and it keeps the render lint-clean).

  const start = parseFloat(startValue);
  const current = parseFloat(currentValue);
  const target = parseFloat(targetValue);
  const valuesValid = !isNaN(start) && !isNaN(current) && !isNaN(target);
  const preview = valuesValid ? krProgressPercent(start, current, target, lowerIsBetter) : null;

  async function handleSave() {
    if (!title.trim() || !valuesValid) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/key-results/${keyResult.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            startValue: start,
            currentValue: current,
            // The default target is what "not set" is stored as.
            targetValue: targetFromLinks ? KR_DEFAULT_TARGET : target,
            unit: unit.trim(),
            lowerIsBetter,
          }),
        },
      );
      if (!res.ok) throw new Error("Failed to update key result");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to update key result:", err);
      notifyError(err, "Couldn't update the key result.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit key result</DialogTitle>
          <DialogDescription>
            Set the metric, its start and target, and how progress is measured.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="kr-title">Title</Label>
            <Input
              id="kr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="kr-start">Start</Label>
              <Input
                id="kr-start"
                type="number"
                value={startValue}
                onChange={(e) => setStartValue(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kr-current">Current</Label>
              <Input
                id="kr-current"
                type="number"
                value={currentValue}
                onChange={(e) => setCurrentValue(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kr-target">Target</Label>
              <Input
                id="kr-target"
                type="number"
                value={targetValue}
                onChange={(e) => {
                  setTargetValue(e.target.value);
                  setTargetFromLinks(false);
                }}
              />
            </div>
          </div>
          {linkedTotal > 0 &&
            (targetFromLinks ? (
              <p className="text-xs text-muted-foreground">
                The target is the {linkedTotal} linked{" "}
                {linkedTotal === 1 ? "ticket" : "tickets"}. Type a number to set your own.
              </p>
            ) : (
              <button
                type="button"
                className="text-xs text-[var(--primary)] hover:underline"
                onClick={() => {
                  setTargetFromLinks(true);
                  setTargetValue(String(linkedTotal));
                }}
              >
                Use the {linkedTotal} linked {linkedTotal === 1 ? "ticket" : "tickets"} as the target
              </button>
            ))}
          <div className="space-y-1.5">
            <Label htmlFor="kr-unit">Unit</Label>
            <Input
              id="kr-unit"
              placeholder="e.g. %, ms, $, users"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-[var(--border)] p-3">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={lowerIsBetter}
              onChange={(e) => setLowerIsBetter(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium">Lower is better</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                For metrics like latency, cost, or defect count. Set{" "}
                <span className="font-medium">Start</span> to today&rsquo;s (higher)
                baseline and <span className="font-medium">Target</span> to the
                lower goal — progress then fills as the value comes down.
              </span>
            </span>
          </label>
          {preview !== null && (
            <p className="text-xs text-muted-foreground">
              Progress with these values:{" "}
              <span className="font-medium tabular-nums text-foreground">{preview}%</span>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !title.trim() || !valuesValid}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
