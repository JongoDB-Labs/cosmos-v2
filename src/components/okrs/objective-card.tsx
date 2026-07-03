"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChevronDown, ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { KeyResultRow } from "./key-result-row";
import { krProgressPercent } from "@/lib/okr/progress";
import type { Objective, KeyResult } from "@/types/models";

interface ObjectiveCardProps {
  objective: Objective;
  onUpdateKeyResult: (krId: string, currentValue: number) => void;
  onAddKeyResult: (objectiveId: string, title: string) => void | Promise<void>;
  onEdit: (objective: Objective) => void;
  onDelete: (objectiveId: string) => void;
  orgId: string;
  projectId: string;
  onCheckedIn: () => void;
}

function computeProgress(keyResults: KeyResult[]): number {
  if (!keyResults || keyResults.length === 0) return 0;
  const total = keyResults.reduce(
    (sum, kr) =>
      sum + krProgressPercent(kr.startValue, kr.currentValue, kr.targetValue, kr.lowerIsBetter),
    0,
  );
  return Math.round(total / keyResults.length);
}

function getProgressColor(percent: number): string {
  if (percent < 30) return "text-red-500";
  if (percent <= 70) return "text-yellow-500";
  return "text-green-500";
}

function getProgressBgColor(percent: number): string {
  if (percent < 30) return "bg-red-500";
  if (percent <= 70) return "bg-yellow-500";
  return "bg-green-500";
}

const statusLabels: Record<Objective["status"], string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export function ObjectiveCard({
  objective,
  onUpdateKeyResult,
  onAddKeyResult,
  onEdit,
  onDelete,
  orgId,
  projectId,
  onCheckedIn,
}: ObjectiveCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAddKr, setShowAddKr] = useState(false);
  const [newKrTitle, setNewKrTitle] = useState("");
  const [addingKr, setAddingKr] = useState(false);
  const keyResults = objective.keyResults ?? [];

  async function handleAddKr() {
    const trimmed = newKrTitle.trim();
    if (!trimmed) return;
    setAddingKr(true);
    try {
      await onAddKeyResult(objective.id, trimmed);
      setNewKrTitle("");
      setShowAddKr(false);
    } finally {
      setAddingKr(false);
    }
  }

  const addKeyResultControl = showAddKr ? (
    <div className="flex items-center gap-2 px-3 pt-1">
      <Input
        className="h-7 text-xs"
        placeholder="Key result title..."
        value={newKrTitle}
        onChange={(e) => setNewKrTitle(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") void handleAddKr();
          if (e.key === "Escape") {
            setShowAddKr(false);
            setNewKrTitle("");
          }
        }}
        autoFocus
      />
      <Button
        size="sm"
        disabled={addingKr || !newKrTitle.trim()}
        onClick={(e) => {
          e.stopPropagation();
          void handleAddKr();
        }}
      >
        {addingKr ? "Adding..." : "Add"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          setShowAddKr(false);
          setNewKrTitle("");
        }}
      >
        Cancel
      </Button>
    </div>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      className="gap-2 text-muted-foreground"
      onClick={(e) => {
        e.stopPropagation();
        setShowAddKr(true);
      }}
    >
      <Plus className="h-3.5 w-3.5" />
      Add Key Result
    </Button>
  );
  const progress = computeProgress(keyResults);
  const ownerName = objective.owner?.user?.displayName ?? "Unassigned";
  const ownerAvatar = objective.owner?.user?.avatarUrl ?? null;
  const ownerInitials = ownerName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="rounded-lg border bg-card">
      <div
        className="flex items-center gap-3 p-4 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <button className="shrink-0 text-muted-foreground">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm truncate">{objective.title}</h3>
            <Badge variant="neutral">{statusLabels[objective.status]}</Badge>
          </div>
          <div className="flex items-center gap-3 mt-1.5">
            <div className="flex-1 max-w-xs h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  getProgressBgColor(progress)
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
            <span
              className={cn("text-xs font-medium", getProgressColor(progress))}
            >
              {progress}%
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Avatar className="h-6 w-6">
            <AvatarImage src={ownerAvatar ?? undefined} />
            <AvatarFallback className="text-[10px]">
              {ownerInitials}
            </AvatarFallback>
          </Avatar>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => e.stopPropagation()}
                />
              }
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(objective);
                }}
              >
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(objective.id);
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded && keyResults.length > 0 && (
        <div className="border-t px-4 pb-3 pt-1">
          <p className="text-xs font-medium text-muted-foreground px-3 py-2">
            Key Results ({keyResults.length})
          </p>
          <div className="space-y-0.5">
            {keyResults
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((kr) => (
                <KeyResultRow
                  key={kr.id}
                  keyResult={kr}
                  onUpdate={onUpdateKeyResult}
                  orgId={orgId}
                  projectId={projectId}
                  onCheckedIn={onCheckedIn}
                />
              ))}
          </div>
          <div className="mt-1">{addKeyResultControl}</div>
        </div>
      )}

      {expanded && keyResults.length === 0 && (
        <div className="border-t px-4 py-4">
          <p className="text-sm text-muted-foreground text-center mb-2">
            No key results yet.
          </p>
          <div className="flex justify-center">{addKeyResultControl}</div>
        </div>
      )}
    </div>
  );
}
