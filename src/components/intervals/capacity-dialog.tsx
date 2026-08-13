"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProjectMembers } from "./use-project-members";
import { useProjectTeams } from "@/hooks/use-project-teams";
import { allocatableMembers } from "@/lib/intervals/allocatable-members";
import { teamsByUser } from "@/lib/teams/item-teams";
import {
  ALL_TEAMS,
  resolveCeremonyTeam,
  scopeMembersToTeam,
} from "@/lib/teams/ceremony-team-scope";
import { notifyError } from "@/lib/errors/notify";

interface CapacityEntry {
  userId: string;
  capacity: number;
  user: { id: string; displayName: string };
}

interface CapacityDialogProps {
  orgId: string;
  projectId: string;
  intervalId: string;
  intervalName: string;
  canEdit: boolean;
  /** Who is looking — used to default the team filter to the one they lead. */
  viewerUserId?: string;
  onClose: () => void;
}

/**
 * Per-member capacity planning for an interval. Reads/writes the existing
 * /intervals/[id]/capacity route (GET returns IntervalCapacity rows; PUT upserts an
 * `entries` array and removes anyone omitted). Candidates are the PROJECT's
 * members with bots excluded — the route keys on User ids, so rows expose
 * `userId` explicitly rather than reusing `id` (which is the ProjectMember id).
 */
export function CapacityDialog({
  orgId,
  projectId,
  intervalId,
  intervalName,
  canEdit,
  viewerUserId = "",
  onClose,
}: CapacityDialogProps) {
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}/intervals/${intervalId}`;
  // Project members, humans only — not the org-wide @-mention roster, which
  // offered everyone in the org plus bots like the Foreman agent.
  const { data: projectMembers } = useProjectMembers(orgId, projectId);
  const allMembers = useMemo(
    () => allocatableMembers(projectMembers ?? []),
    [projectMembers],
  );

  // A ceremony belongs to a TEAM. Listing every member of the project made a
  // lead sizing their own sprint mentally subtract the other squads — the
  // equivalent of every scrum team sitting in each other's planning.
  const { data: teams } = useProjectTeams(orgId, projectId);
  const [teamChoice, setTeamChoice] = useState<string | null>(null);
  const roster = useMemo(() => teamsByUser(teams ?? []), [teams]);
  const viewerTeams = useMemo(
    () =>
      (teams ?? [])
        .filter((t) => t.members.some((m) => m.userId === viewerUserId))
        .map((t) => ({
          id: t.id,
          name: t.name,
          isLead: t.members.some((m) => m.userId === viewerUserId && m.isLead),
        })),
    [teams, viewerUserId],
  );
  const { teamId } = resolveCeremonyTeam({
    boardTeamId: null,
    selectedTeamId: teamChoice,
    viewerTeams,
  });
  const members = useMemo(
    () => scopeMembersToTeam(allMembers, teamId, roster),
    [allMembers, teamId, roster],
  );

  // userId -> hours, as a string for the controlled input.
  const [hours, setHours] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadCapacity = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${basePath}/capacity`);
      if (!res.ok) throw new Error("Failed to load capacity");
      const rows: CapacityEntry[] = await res.json();
      const map: Record<string, string> = {};
      for (const r of rows) map[r.userId] = String(r.capacity);
      setHours(map);
    } catch (err) {
      notifyError(err, "Couldn't load capacity.");
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    loadCapacity();
  }, [loadCapacity]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function save() {
    setSaving(true);
    try {
      const entries = Object.entries(hours)
        .map(([userId, h]) => ({ userId, capacity: Number(h) }))
        .filter((e) => Number.isFinite(e.capacity) && e.capacity > 0);
      const res = await fetch(`${basePath}/capacity`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) throw new Error("Failed to save capacity");
      onClose();
    } catch (err) {
      notifyError(err, "Couldn't save capacity.");
    } finally {
      setSaving(false);
    }
  }

  // Totals the VISIBLE members, so a team's number is that team's number.
  //
  // `hours` itself deliberately stays whole: `save()` sends every entry in it
  // and the route REMOVES anyone omitted, so narrowing the state to the current
  // team would silently delete every other team's capacity the moment a lead
  // pressed Save. Filter what is rendered and summed, never what is stored.
  const total = members.reduce((sum, m) => {
    const n = Number(hours[m.userId]);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Capacity — {intervalName}</DialogTitle>
          <DialogDescription>
            Planned hours per member for this interval. Used alongside velocity to
            flag over-commitment.
          </DialogDescription>
        </DialogHeader>

        {/* Scope to one squad. A ceremony belongs to a team; planning against
            the whole project asks a lead to size work for people they do not
            run. Only offered when the project HAS teams. */}
        {(teams ?? []).length > 0 ? (
          <div className="flex items-center gap-2 border-b border-[var(--border)] pb-3">
            <label htmlFor="capacity-team" className="text-sm text-muted-foreground">
              Team
            </label>
            <select
              id="capacity-team"
              value={teamId ?? ALL_TEAMS}
              onChange={(e) => setTeamChoice(e.target.value)}
              className="h-9 rounded-[calc(var(--radius)-2px)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
            >
              <option value={ALL_TEAMS}>All teams</option>
              {(teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {loading || !projectMembers ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : members.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            {teamId
              ? "Nobody is on this team yet."
              : "No members to plan capacity for."}
          </p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto py-1">
            {members.map((m) => (
              <div key={m.userId} className="flex items-center justify-between gap-3">
                <span className="truncate text-sm">{m.displayName}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    aria-label={`Capacity hours for ${m.displayName}`}
                    className="w-24"
                    disabled={!canEdit}
                    value={hours[m.userId] ?? ""}
                    onChange={(e) =>
                      setHours((prev) => ({ ...prev, [m.userId]: e.target.value }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">hrs</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="items-center justify-between sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Total: <span className="font-medium text-foreground">{total} hrs</span>
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              {canEdit ? "Cancel" : "Close"}
            </Button>
            {canEdit && (
              <Button onClick={save} disabled={saving || loading}>
                {saving ? "Saving…" : "Save capacity"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
