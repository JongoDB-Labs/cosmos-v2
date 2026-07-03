"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { KeyResult } from "@/types/models";
import { KeyResultCheckinDialog, RAG_META } from "./key-result-checkin-dialog";

interface KeyResultRowProps {
  keyResult: KeyResult;
  onUpdate: (id: string, currentValue: number) => void;
  orgId: string;
  projectId: string;
  /** Called after a successful check-in so the board refetches (progress + RAG). */
  onCheckedIn: () => void;
}

const statusLabels: Record<KeyResult["status"], string> = {
  NOT_STARTED: "Not Started",
  IN_PROGRESS: "In Progress",
  AT_RISK: "At Risk",
  ON_TRACK: "On Track",
  DONE: "Done",
};

const statusVariants: Record<KeyResult["status"], "neutral" | "progress" | "critical" | "done"> = {
  NOT_STARTED: "neutral",
  IN_PROGRESS: "progress",
  AT_RISK: "critical",
  ON_TRACK: "done",
  DONE: "done",
};

function getProgressPercent(kr: KeyResult): number {
  if (kr.targetValue === kr.startValue) return 100;
  const range = kr.targetValue - kr.startValue;
  const progress = kr.currentValue - kr.startValue;
  return Math.min(100, Math.max(0, Math.round((progress / range) * 100)));
}

function getProgressColor(percent: number): string {
  if (percent < 30) return "bg-red-500";
  if (percent <= 70) return "bg-yellow-500";
  return "bg-green-500";
}

export function KeyResultRow({
  keyResult,
  onUpdate,
  orgId,
  projectId,
  onCheckedIn,
}: KeyResultRowProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(String(keyResult.currentValue));
  const [checkinOpen, setCheckinOpen] = useState(false);

  const progress = getProgressPercent(keyResult);

  function handleSave() {
    const num = parseFloat(editValue);
    if (!isNaN(num)) {
      // Fire celebrate() when a KR crosses into 100% completion as a result
      // of this update — once per crossing.
      const wasComplete = getProgressPercent(keyResult) >= 100;
      const willBeComplete =
        keyResult.targetValue === keyResult.startValue ||
        num >= keyResult.targetValue;
      onUpdate(keyResult.id, num);
      if (!wasComplete && willBeComplete) {
        void import("@/lib/confetti").then(({ celebrate }) => celebrate());
      }
    }
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setEditValue(String(keyResult.currentValue));
      setEditing(false);
    }
  }

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-muted/50 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{keyResult.title}</p>
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", getProgressColor(progress))}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {progress}%
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {editing ? (
          <Input
            className="w-20 h-6 text-xs"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        ) : (
          <button
            onClick={() => {
              setEditValue(String(keyResult.currentValue));
              setEditing(true);
            }}
            className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted hover:bg-muted/80 transition-colors cursor-pointer"
            title="Click to edit"
          >
            {keyResult.currentValue} / {keyResult.targetValue}
            {keyResult.unit ? ` ${keyResult.unit}` : ""}
          </button>
        )}

        {keyResult.rag && (
          <span
            className="flex items-center gap-1"
            title={`${RAG_META[keyResult.rag].label}${
              keyResult.confidence != null ? ` · ${keyResult.confidence}% confidence` : ""
            }`}
          >
            <span className={cn("size-2.5 rounded-full", RAG_META[keyResult.rag].dot)} />
            {keyResult.confidence != null && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {keyResult.confidence}%
              </span>
            )}
          </span>
        )}

        <button
          onClick={() => setCheckinOpen(true)}
          className="rounded-md border border-[var(--border)] px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Check in
        </button>

        <Badge variant={statusVariants[keyResult.status]}>
          {statusLabels[keyResult.status]}
        </Badge>
      </div>

      <KeyResultCheckinDialog
        orgId={orgId}
        projectId={projectId}
        keyResult={keyResult}
        open={checkinOpen}
        onOpenChange={setCheckinOpen}
        onDone={onCheckedIn}
      />
    </div>
  );
}
