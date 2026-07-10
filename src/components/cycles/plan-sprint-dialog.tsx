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
import { Play, Target, Users, Gauge } from "lucide-react";

interface PlanCycle {
  id: string;
  name: string;
  goal: string | null;
  startDate: string;
  endDate: string;
  _count?: { workItems: number };
}

interface PlanSprintDialogProps {
  orgId: string;
  projectId: string;
  cycle: PlanCycle;
  onClose: () => void;
  /** Called after the sprint is successfully started, to refresh the list. */
  onStarted: () => void;
}

interface CapacityRow {
  userId: string;
  capacity: number;
}

interface CycleItem {
  storyPoints: number | null;
}

/**
 * Sprint-planning flow (AC: "Starting a sprint launches a planning flow that
 * surfaces per-member capacity plus additional planning inputs"). Opened when a
 * planned sprint is started. Surfaces the committed scope, lets the team set a
 * goal + per-member capacity + a commitment, then activates the sprint —
 * stashing a planning snapshot in `report.plan` for the end-of-sprint review.
 */
export function PlanSprintDialog({
  orgId,
  projectId,
  cycle,
  onClose,
  onStarted,
}: PlanSprintDialogProps) {
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}/cycles/${cycle.id}`;
  const { data: members } = useOrgMembers(orgId);

  const [hours, setHours] = useState<Record<string, string>>({});
  const [goal, setGoal] = useState(cycle.goal ?? "");
  const [committed, setCommitted] = useState("");
  const [scopePoints, setScopePoints] = useState(0);
  const [itemCount, setItemCount] = useState(cycle._count?.workItems ?? 0);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [capRes, cycleRes] = await Promise.all([
        fetch(`${basePath}/capacity`),
        fetch(`${basePath}`),
      ]);
      if (!capRes.ok || !cycleRes.ok) throw new Error("Failed to load sprint plan");
      const capRows: CapacityRow[] = await capRes.json();
      const cycleData: { goal?: string | null; workItems?: CycleItem[] } =
        await cycleRes.json();

      const map: Record<string, string> = {};
      for (const r of capRows) map[r.userId] = String(r.capacity);
      const items = cycleData.workItems ?? [];
      const points = items.reduce((s, i) => s + (i.storyPoints ?? 0), 0);

      setHours(map);
      setScopePoints(points);
      setItemCount(items.length);
      setCommitted(String(points));
    } catch (err) {
      notifyError(err, "Couldn't load the sprint plan.");
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const totalHours = Object.values(hours).reduce((sum, h) => {
    const n = Number(h);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);

  const committedPoints = Number(committed);
  const overCommitted = scopePoints > 0 && committedPoints > scopePoints;

  async function startSprint() {
    setStarting(true);
    try {
      // Persist capacity first (so a failed activation doesn't lose the edits).
      const entries = Object.entries(hours)
        .map(([userId, h]) => ({ userId, capacity: Number(h) }))
        .filter((e) => Number.isFinite(e.capacity) && e.capacity > 0);
      const capRes = await fetch(`${basePath}/capacity`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (!capRes.ok) throw new Error("Failed to save capacity");

      // Activate + stash the planning snapshot for the sprint review.
      const res = await fetch(`${basePath}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: goal.trim() || null,
          status: "ACTIVE",
          plan: {
            committedPoints: Number.isFinite(committedPoints) ? Math.max(0, committedPoints) : 0,
            capacityHours: totalHours,
          },
        }),
      });
      if (res.status === 409)
        throw new Error("Another sprint is already active — complete it first.");
      if (!res.ok) throw new Error("Failed to start sprint");
      onStarted();
      onClose();
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
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Plan &amp; start — {cycle.name}</DialogTitle>
          <DialogDescription>
            Review scope and team capacity, set the goal and commitment, then
            start the sprint.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Scope summary */}
            <div className="grid grid-cols-3 gap-3 rounded-lg border bg-muted/40 p-3 text-center">
              <div>
                <p className="text-lg font-semibold">{itemCount}</p>
                <p className="text-[11px] text-muted-foreground">items</p>
              </div>
              <div>
                <p className="text-lg font-semibold">{scopePoints}</p>
                <p className="text-[11px] text-muted-foreground">story points</p>
              </div>
              <div>
                <p className="text-lg font-semibold">{totalHours}</p>
                <p className="text-[11px] text-muted-foreground">capacity hrs</p>
              </div>
            </div>

            {/* Goal */}
            <div className="space-y-1.5">
              <Label htmlFor="plan-goal" className="flex items-center gap-1.5">
                <Target className="h-3.5 w-3.5" /> Sprint goal
              </Label>
              <Input
                id="plan-goal"
                placeholder="What should this sprint achieve?"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </div>

            {/* Commitment */}
            <div className="space-y-1.5">
              <Label htmlFor="plan-committed" className="flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5" /> Commitment (story points)
              </Label>
              <Input
                id="plan-committed"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                className="w-32"
                value={committed}
                onChange={(e) => setCommitted(e.target.value)}
              />
              {overCommitted && (
                <p className="text-[11px] text-amber-600 dark:text-amber-500">
                  Commitment exceeds the {scopePoints} points currently in scope.
                </p>
              )}
            </div>

            {/* Per-member capacity */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" /> Capacity per member (hrs)
              </Label>
              {!members ? (
                <div className="space-y-2 py-1">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : members.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  No members to plan capacity for.
                </p>
              ) : (
                <div className="max-h-52 space-y-2 overflow-y-auto py-1">
                  {members.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm">{m.displayName}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          aria-label={`Capacity hours for ${m.displayName}`}
                          className="w-24"
                          value={hours[m.id] ?? ""}
                          onChange={(e) =>
                            setHours((prev) => ({ ...prev, [m.id]: e.target.value }))
                          }
                        />
                        <span className="text-xs text-muted-foreground">hrs</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button onClick={startSprint} disabled={starting || loading}>
            <Play className="h-3.5 w-3.5 mr-1" />
            {starting ? "Starting…" : "Start sprint"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
