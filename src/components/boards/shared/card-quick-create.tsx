"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Loader2 } from "lucide-react";
import { notifyError } from "@/lib/errors/notify";
import type { WorkItem } from "@/types/models";

interface CardQuickCreateProps {
  columnKey: string;
  projectId: string;
  orgId: string;
  projectKey: string;
  onCreated: (item: WorkItem) => void;
}

const TYPES = ["TASK", "STORY", "BUG", "EPIC", "SUBTASK"] as const;

export function CardQuickCreate({
  columnKey,
  projectId,
  orgId,
  projectKey,
  onCreated,
}: CardQuickCreateProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("TASK");
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  function handleSubmit() {
    if (!title.trim()) return;

    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/projects/${projectId}/work-items`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: title.trim(),
              type,
              columnKey,
            }),
          }
        );

        if (!res.ok) throw new Error("Failed to create item");

        const item: WorkItem = await res.json();
        onCreated(item);
        setTitle("");
        setType("TASK");
        setOpen(false);
      } catch (err) {
        console.error("Failed to create card:", err);
        notifyError(err, "Couldn't create the card.");
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      setTitle("");
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        Add card
      </button>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-2 space-y-2">
      <Input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Card title..."
        className="h-7 text-xs"
        disabled={isPending}
      />
      <div className="flex items-center justify-between gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
          className="h-6 rounded border border-input bg-transparent px-1.5 text-xs outline-none"
          disabled={isPending}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0) + t.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setTitle("");
              setOpen(false);
            }}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            size="xs"
            onClick={handleSubmit}
            disabled={!title.trim() || isPending}
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );
}
