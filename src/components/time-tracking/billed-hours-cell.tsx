"use client";

import { useState } from "react";
import { Check, X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import type { TimeEntry } from "@/types/models";

/**
 * What this entry bills, and the control to change it.
 *
 * Billing is a SECOND decision taken from the approved log, not an edit to it —
 * which is why this sits beside Hours rather than replacing it. Both numbers stay
 * on screen, because the gap between them is the thing somebody may later have to
 * account for.
 *
 * Shows "as logged" rather than repeating the figure when no decision has been
 * taken. Two identical numbers side by side invite the reader to work out whether
 * they are supposed to differ; the words say it outright.
 */
export function BilledHoursCell({
  entry,
  orgId,
  onSaved,
}: {
  entry: TimeEntry;
  orgId: string;
  onSaved: (updated: { id: string; billedHours: number | null }) => void;
}) {
  const { can } = usePermissions();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only approved entries can be billed, mirroring the route. Showing the control
  // on a draft would offer an action that always fails.
  const billable = can(Permission.TIME_BILL) && entry.status === "APPROVED";
  const decided = entry.billedHours !== null;

  async function save(next: number | null) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/time-entries/${entry.id}/billed`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billedHours: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not save");
        return;
      }
      onSaved({ id: entry.id, billedHours: next });
      setEditing(false);
    } catch {
      setError("Could not save");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          type="number"
          step="0.25"
          min="0"
          max="24"
          className="h-7 w-20"
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save(value === "" ? null : Number(value));
            if (e.key === "Escape") setEditing(false);
          }}
          aria-label="Billed hours"
        />
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={saving}
          onClick={() => void save(value === "" ? null : Number(value))}
          aria-label="Save billed hours"
        >
          <Check className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={saving}
          onClick={() => setEditing(false)}
          aria-label="Cancel"
        >
          <X className="size-3" />
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  const label = decided ? (
    <span className="font-medium">
      {entry.billedHours!.toFixed(2)}
      {entry.billedHours! !== entry.hours && (
        <span
          className={
            entry.billedHours! < entry.hours ? "ml-1 text-amber-600" : "ml-1 text-emerald-600"
          }
        >
          ({entry.billedHours! > entry.hours ? "+" : ""}
          {(entry.billedHours! - entry.hours).toFixed(2)})
        </span>
      )}
    </span>
  ) : (
    <span className="text-xs text-[var(--text-muted)]">as logged</span>
  );

  if (!billable) return label;

  return (
    <button
      type="button"
      className="group inline-flex items-center gap-1 rounded px-1 hover:bg-[var(--surface-hover)]"
      onClick={() => {
        setValue(decided ? String(entry.billedHours) : String(entry.hours));
        setEditing(true);
      }}
      title={`${entry.hours.toFixed(2)}h logged — click to set billed hours`}
    >
      {label}
      <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
    </button>
  );
}
