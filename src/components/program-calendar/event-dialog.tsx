"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ChipCategory } from "./event-chip";

export interface EventDraft {
  id?: string;
  title: string;
  categoryId: string;
  /** `yyyy-mm-dd`, read and written as a plain date. */
  startDate: string;
  endDate: string;
  /** `HH:mm`, 24-hour. Ignored when allDay. */
  startTime: string;
  endTime: string;
  allDay: boolean;
  timeZone: string;
  location: string;
  ownerKey: string;
  attendees: string;
  recurrence: string;
  deliverableId: string;
  customerAttending: boolean;
  description: string;
  showOnDashboard: boolean;
}

export const RECURRENCES = [
  ["NONE", "Does not repeat"],
  ["DAILY", "Daily"],
  ["WEEKLY", "Weekly"],
  ["BIWEEKLY", "Every two weeks"],
  ["MONTHLY", "Monthly"],
  ["QUARTERLY", "Quarterly"],
  ["ANNUALLY", "Annually"],
] as const;

/**
 * Create or edit a program event.
 *
 * Dates are held as `yyyy-mm-dd` STRINGS all the way through the form and only
 * become instants at the boundary. A `<input type="date">` hands back a plain
 * date, and the moment that is parsed into a `Date` it acquires the browser's
 * zone — which is how a 30 Nov all-day event gets stored as 29 Nov for anyone
 * west of UTC. Keeping it a string means the conversion happens once, in one
 * place, where the all-day rule is applied.
 *
 * The END DATE is inclusive as presented: "30 Nov – 4 Dec" is five days. The
 * service converts that to the half-open range it stores.
 */
export function EventDialog({
  open,
  onOpenChange,
  draft,
  categories,
  owners,
  deliverables,
  saving,
  onSave,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  draft: EventDraft | null;
  categories: ChipCategory[];
  owners: { key: string; label: string }[];
  deliverables: { id: string; name: string }[];
  saving?: boolean;
  onSave: (d: EventDraft) => void;
  onDelete?: (id: string) => void;
}) {
  // Closed means UNMOUNTED, not hidden. The form's state is seeded from
  // `draft` at mount, so the alternative — keeping it mounted and copying the
  // prop into state from an effect — both trips the repo's
  // `set-state-in-effect` rule and leaves a window where the dialog shows the
  // previous event's values. Unmounting makes the seed correct by
  // construction; the `key` additionally forces a remount if the parent swaps
  // the draft while it is open.
  if (!open || !draft) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <EventForm
        key={draft.id ?? `new:${draft.startDate}`}
        initial={draft}
        categories={categories}
        owners={owners}
        deliverables={deliverables}
        saving={saving}
        onSave={onSave}
        onDelete={onDelete}
        onOpenChange={onOpenChange}
      />
    </Dialog>
  );
}

function EventForm({
  initial,
  categories,
  owners,
  deliverables,
  saving,
  onSave,
  onDelete,
  onOpenChange,
}: {
  initial: EventDraft;
  categories: ChipCategory[];
  owners: { key: string; label: string }[];
  deliverables: { id: string; name: string }[];
  saving?: boolean;
  onSave: (d: EventDraft) => void;
  onDelete?: (id: string) => void;
  onOpenChange: (o: boolean) => void;
}) {
  const [form, setForm] = useState<EventDraft>(initial);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof EventDraft>(k: K, v: EventDraft[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    if (!form.title.trim()) return setError("Give the event a title.");
    if (!form.categoryId) return setError("Pick a category.");
    if (form.endDate < form.startDate) return setError("The end date is before the start date.");
    if (!form.allDay && form.startDate === form.endDate && form.endTime < form.startTime) {
      return setError("The end time is before the start time.");
    }
    setError(null);
    onSave(form);
  };

  return (
    <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{form.id ? "Edit event" : "New event"}</DialogTitle>
          <DialogDescription>
            {form.allDay
              ? "An all-day event is on its dates in every time zone."
              : "Times are shown in the event's own time zone."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[60vh] gap-4 overflow-y-auto px-1">
          <div className="grid gap-1.5">
            <Label htmlFor="pc-title">Event title</Label>
            <Input
              id="pc-title"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="O-6 IPR, system demo, exercise…"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Category</Label>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => set("categoryId", c.id)}
                  aria-pressed={form.categoryId === c.id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    form.categoryId === c.id ? "border-ring bg-muted" : "border-transparent bg-muted/50 hover:bg-muted",
                  )}
                >
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: `rgb(${c.tintRgb})` }}
                  />
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="pc-start">Start date</Label>
              <Input id="pc-start" type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pc-end">End date</Label>
              <Input id="pc-end" type="date" value={form.endDate} onChange={(e) => set("endDate", e.target.value)} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(e) => set("allDay", e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            All day
          </label>

          {!form.allDay ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="pc-st">Start time</Label>
                <Input id="pc-st" type="time" step={900} value={form.startTime} onChange={(e) => set("startTime", e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="pc-et">End time</Label>
                <Input id="pc-et" type="time" step={900} value={form.endTime} onChange={(e) => set("endTime", e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="pc-tz">Time zone</Label>
                <select
                  id="pc-tz"
                  value={form.timeZone}
                  onChange={(e) => set("timeZone", e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                >
                  {["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC"].map((z) => (
                    <option key={z} value={z}>
                      {z.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="pc-loc">Location</Label>
              <Input id="pc-loc" value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Room, base or link" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pc-owner">Owner</Label>
              <select
                id="pc-owner"
                value={form.ownerKey}
                onChange={(e) => set("ownerKey", e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                <option value="">Unassigned</option>
                {owners.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="pc-att">Attendees</Label>
              <Input id="pc-att" value={form.attendees} onChange={(e) => set("attendees", e.target.value)} placeholder="Names or emails" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pc-rec">Recurrence</Label>
              <select
                id="pc-rec"
                value={form.recurrence}
                onChange={(e) => set("recurrence", e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                {RECURRENCES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="pc-del">Deliverable</Label>
              <select
                id="pc-del"
                value={form.deliverableId}
                onChange={(e) => set("deliverableId", e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                <option value="">None</option>
                {deliverables.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={form.customerAttending}
                onChange={(e) => set("customerAttending", e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              Customer attending
            </label>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="pc-desc">Description, notes and checklists</Label>
            <Textarea
              id="pc-desc"
              rows={5}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Agenda, notes, checklists, links"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.showOnDashboard}
              onChange={(e) => set("showOnDashboard", e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            Show on the dashboard when it falls in the next 14 days
          </label>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="justify-between sm:justify-between">
          <div>
            {form.id && onDelete ? (
              <Button variant="ghost" className="text-destructive" onClick={() => onDelete(form.id!)}>
                Delete
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "Saving…" : "Save event"}
            </Button>
          </div>
        </DialogFooter>
    </DialogContent>
  );
}
