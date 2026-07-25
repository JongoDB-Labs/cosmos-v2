"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOrgMembers } from "@/components/chat/mention-typeahead";
import { notifyError } from "@/lib/errors/notify";
import { AlertTriangle } from "lucide-react";
import {
  type CapacityUnit,
  effectiveCapacity,
  teamCapacity,
  unitAbbrev,
  unitNoun,
  isOverCommitted,
} from "@/lib/intervals/sprint-planning";

interface PlanningData {
  unit: CapacityUnit;
  goal: string;
  committed: { total: number; itemCount: number };
  current: Record<string, number>;
  suggestions: Record<string, number>;
  defaultCapacity: number;
}

interface StartSprintDialogProps {
  orgId: string;
  projectId: string;
  interval: { id: string; name: string; goal: string | null };
  onClose: () => void;
  onStarted: () => void;
}

// Per-member editable planning row (strings for controlled inputs).
interface Row {
  base: string;
  availability: string;
}

/**
 * The Start Sprint planning flow. Before a sprint activates it surfaces
 * per-member capacity (in the project's unit — points or hours), an optional
 * availability %, a running team total, the sprint goal, and a live
 * committed-scope vs capacity indicator with an over-commitment warning.
 *
 * On confirm it saves capacity (effective = base × availability), persists the
 * goal, then flips the interval to ACTIVE.
 */
export function StartSprintDialog({
  orgId,
  projectId,
  interval,
  onClose,
  onStarted,
}: StartSprintDialogProps) {
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}/intervals/${interval.id}`;
  const { data: members } = useOrgMembers(orgId);

  const [plan, setPlan] = useState<PlanningData | null>(null);
  const [loading, setLoading] = useState(true);
  const [goal, setGoal] = useState(interval.goal ?? "");
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [starting, setStarting] = useState(false);

  const loadPlan = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${basePath}/planning`);
      if (!res.ok) throw new Error("Failed to load planning data");
      const data: PlanningData = await res.json();
      setPlan(data);
      setGoal((g) => g || data.goal);
    } catch (err) {
      notifyError(err, "Couldn't load sprint planning data.");
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    loadPlan();
  }, [loadPlan]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const unit: CapacityUnit = plan?.unit ?? "hours";
  const abbrev = unitAbbrev(unit);

  // The row for a member: their edits if any, else defaults derived from the
  // plan (saved capacity ?? recent-velocity suggestion ?? constant; 100% avail).
  // Deriving on read (rather than seeding state) keeps the inputs correct on the
  // very first render, with no effect race.
  const rowFor = useCallback(
    (id: string): Row => ({
      base:
        rows[id]?.base ??
        (plan
          ? String(plan.current[id] ?? plan.suggestions[id] ?? plan.defaultCapacity)
          : ""),
      availability: rows[id]?.availability ?? "100",
    }),
    [rows, plan],
  );

  const team = members
    ? teamCapacity(
        members.map((m) => {
          const r = rowFor(m.id);
          return { base: Number(r.base), availabilityPct: Number(r.availability) };
        }),
      )
    : 0;

  const committed = plan?.committed.total ?? 0;
  const over = isOverCommitted(committed, team);

  async function start() {
    if (!plan) return;
    setStarting(true);
    try {
      // 1. Save per-member effective capacity (base × availability).
      const entries = (members ?? [])
        .map((m) => {
          const r = rowFor(m.id);
          return {
            userId: m.id,
            capacity: effectiveCapacity(Number(r.base), Number(r.availability)),
          };
        })
        .filter((e) => Number.isFinite(e.capacity) && e.capacity > 0);
      const capRes = await fetch(`${basePath}/capacity`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (!capRes.ok) throw new Error("Failed to save capacity");

      // 2. Persist the goal (if changed) and activate the sprint in one PUT.
      const goalChanged = goal.trim() !== (interval.goal ?? "").trim();
      const res = await fetch(basePath, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "ACTIVE",
          ...(goalChanged && { goal: goal.trim() || null }),
        }),
      });
      if (res.status === 409)
        throw new Error("Another interval is already active — complete it first.");
      if (!res.ok) throw new Error("Failed to start sprint");

      onStarted();
    } catch (err) {
      notifyError(
        err,
        err instanceof Error ? err.message : "Couldn't start the sprint.",
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start {interval.name}</DialogTitle>
          <DialogDescription>
            Plan capacity and commitment in {unitNoun(unit)} before the sprint
            begins.
          </DialogDescription>
        </DialogHeader>

        {loading || !members || !plan ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Sprint goal */}
            <div className="space-y-1.5">
              <Label htmlFor="sprint-goal">Sprint goal</Label>
              <Input
                id="sprint-goal"
                placeholder="What should this sprint achieve?"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </div>

            {/* Capacity section */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Team capacity ({abbrev})</Label>
                <span className="text-xs text-muted-foreground">
                  Base × availability
                </span>
              </div>
              {members.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  No members to plan capacity for.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <span>Member</span>
                    <span className="w-20 text-right">Base</span>
                    <span className="w-16 text-right">Avail %</span>
                    <span className="w-14 text-right">Eff.</span>
                  </div>
                  <div className="max-h-64 space-y-1.5 overflow-y-auto">
                    {members.map((m) => {
                      const row = rowFor(m.id);
                      const eff = effectiveCapacity(
                        Number(row.base),
                        Number(row.availability),
                      );
                      return (
                        <div
                          key={m.id}
                          className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm">{m.displayName}</div>
                            {m.email && (
                              <div className="truncate text-xs text-muted-foreground">
                                {m.email}
                              </div>
                            )}
                          </div>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            inputMode="numeric"
                            aria-label={`Capacity (${abbrev}) for ${m.displayName}`}
                            className="w-20 text-right"
                            value={row.base}
                            onChange={(e) =>
                              setRows((prev) => ({
                                ...prev,
                                [m.id]: { ...row, base: e.target.value },
                              }))
                            }
                          />
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            step={5}
                            inputMode="numeric"
                            aria-label={`Availability % for ${m.displayName}`}
                            className="w-16 text-right"
                            value={row.availability}
                            onChange={(e) =>
                              setRows((prev) => ({
                                ...prev,
                                [m.id]: { ...row, availability: e.target.value },
                              }))
                            }
                          />
                          <span className="w-14 text-right text-sm tabular-nums text-muted-foreground">
                            {eff}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              <div className="flex items-center justify-between border-t pt-2 text-sm">
                <span className="text-muted-foreground">Team capacity</span>
                <span className="font-medium tabular-nums">
                  {team} {abbrev}
                </span>
              </div>
            </div>

            {/* Committed scope vs capacity */}
            <div
              className={
                "rounded-md border px-3 py-2 text-sm " +
                (over
                  ? "border-destructive/40 bg-destructive/5"
                  : "border-border bg-muted/40")
              }
            >
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  Committed scope · {plan.committed.itemCount} item
                  {plan.committed.itemCount === 1 ? "" : "s"}
                </span>
                <span className="font-medium tabular-nums">
                  {committed} / {team} {abbrev}
                </span>
              </div>
              {over && (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Over capacity by {Math.round((committed - team) * 10) / 10}{" "}
                  {abbrev} — consider trimming scope or raising availability.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button onClick={start} disabled={starting || loading}>
            {starting ? "Starting…" : "Start sprint"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
