"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Loader2 } from "lucide-react";
import { notifyError } from "@/lib/errors/notify";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import type { WorkItem } from "@/types/models";

interface CardQuickCreateProps {
  columnKey: string;
  projectId: string;
  orgId: string;
  projectKey: string;
  onCreated: (item: WorkItem) => void;
}

/**
 * Pick the default type to preselect: the project's "task" type if present
 * (built-in keys end with `.task`), else the first type. Returns "" while the
 * list is still loading/empty.
 */
function defaultTypeId(types: { id: string; key: string }[]): string {
  if (types.length === 0) return "";
  const task = types.find((t) => t.key === "task" || t.key.endsWith(".task"));
  return (task ?? types[0]).id;
}

export function CardQuickCreate({
  columnKey,
  projectId,
  orgId,
  projectKey,
  onCreated,
}: CardQuickCreateProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [workItemTypeId, setWorkItemTypeId] = useState("");
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const { can } = usePermissions();
  // The org's ACTUAL types (built-ins + custom). We submit the selected type's
  // id so a custom type (bare key like "feature") resolves on create.
  const { types: workItemTypes } = useWorkItemTypes(orgId);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Default / repair the Type selection from the org's types (re-run when they
  // load while the inline form is open).
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorkItemTypeId((prev) =>
      prev && workItemTypes.some((t) => t.id === prev)
        ? prev
        : defaultTypeId(workItemTypes),
    );
  }, [open, workItemTypes]);

  function handleSubmit() {
    if (!title.trim() || !workItemTypeId) return;

    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/projects/${projectId}/work-items`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: title.trim(),
              workItemTypeId,
              columnKey,
            }),
          }
        );

        if (!res.ok) throw new Error("Failed to create item");

        const item: WorkItem = await res.json();
        onCreated(item);
        setTitle("");
        setWorkItemTypeId(defaultTypeId(workItemTypes));
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

  // Hide the affordance entirely from users who can't create items — the API
  // gates POST on ITEM_CREATE, so showing the form to them would only lead to a
  // 403 after they've typed a title (the table view already hides it this way).
  if (!can(Permission.ITEM_CREATE)) return null;

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
          value={workItemTypeId}
          onChange={(e) => setWorkItemTypeId(e.target.value)}
          className="h-6 rounded border border-input bg-transparent px-1.5 text-xs outline-none"
          disabled={isPending || workItemTypes.length === 0}
        >
          {workItemTypes.length === 0 && <option value="">Loading…</option>}
          {workItemTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
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
            disabled={!title.trim() || !workItemTypeId || isPending}
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );
}
