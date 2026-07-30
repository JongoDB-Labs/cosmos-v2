"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users, Plus, X, Trash2, Loader2, Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import {
  rosterFor,
  unassignedMembers,
  type MemberLike,
  type TeamLike,
} from "@/lib/teams/team-roster";

interface TeamApiRow {
  id: string;
  name: string;
  key: string | null;
  members: { id: string; projectMemberId: string; isLead: boolean; displayName: string }[];
}

interface ProjectMemberRow {
  id: string;
  userId: string;
  displayName: string;
  isBot?: boolean;
  teamIds?: string[];
}

/**
 * Teams within a project — the screen for the API #519 shipped.
 *
 * Deliberately its own component rather than more of project-members-manager:
 * that file is already the busiest thing on this page, and teams are a distinct
 * concern (who works together) from membership (who is on the project at all).
 *
 * Everything here requires canManage. Once the project's Visibility switch is
 * on, team membership decides who can see the project, so editing teams is an
 * access-control action rather than a roster tidy-up.
 */
export function ProjectTeamsSection({
  orgId,
  projectId,
  canManage,
}: {
  orgId: string;
  projectId: string;
  canManage: boolean;
}) {
  const base = `/api/v1/orgs/${orgId}/projects/${projectId}/teams`;
  const teamsKey = useOrgQueryKey("project-teams", projectId);
  // Distinct from the "allocatable" key the capacity dialog uses and from the
  // members manager's own key: same endpoint, different projection.
  const membersKey = useOrgQueryKey("project-members", "teams-section", projectId);

  const { data: teams = [], refetch: refetchTeams } = useQuery({
    queryKey: teamsKey,
    queryFn: () => jsonFetch<TeamApiRow[]>(base),
  });
  const { data: members = [] } = useQuery({
    queryKey: membersKey,
    queryFn: () =>
      jsonFetch<ProjectMemberRow[]>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/members`,
      ),
  });

  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [addingTo, setAddingTo] = useState<string | null>(null);

  const roster: MemberLike[] = members.map((m) => ({
    id: m.id,
    userId: m.userId,
    displayName: m.displayName,
    isBot: m.isBot === true,
  }));
  const teamLikes: TeamLike[] = teams.map((t) => ({
    id: t.id,
    name: t.name,
    members: t.members.map((m) => ({ projectMemberId: m.projectMemberId, isLead: m.isLead })),
  }));
  const spare = unassignedMembers(roster, teamLikes);

  async function createTeam() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        // 409 carries a real message ("a team with that name already exists");
        // surfacing it beats a generic failure the user cannot act on.
        throw new Error(j.error ?? "Couldn't create the team.");
      }
      setNewName("");
      await refetchTeams();
      toast.success("Team created.");
    } catch (err) {
      notifyError(err, "Couldn't create the team.");
    } finally {
      setBusy(false);
    }
  }

  async function addMember(teamId: string, projectMemberId: string) {
    setBusy(true);
    try {
      const res = await fetch(`${base}/${teamId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectMemberId }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't add them to the team.");
      }
      setAddingTo(null);
      await refetchTeams();
    } catch (err) {
      notifyError(err, "Couldn't add them to the team.");
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(teamId: string, projectMemberId: string) {
    setBusy(true);
    try {
      const res = await fetch(
        `${base}/${teamId}?projectMemberId=${encodeURIComponent(projectMemberId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Couldn't remove them from the team.");
      await refetchTeams();
    } catch (err) {
      notifyError(err, "Couldn't remove them from the team.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteTeam(teamId: string, name: string) {
    setBusy(true);
    try {
      const res = await fetch(`${base}/${teamId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Couldn't delete the team.");
      await refetchTeams();
      toast.success(`Deleted ${name}.`);
    } catch (err) {
      notifyError(err, "Couldn't delete the team.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-6 mt-8 border-t pt-6">
      <div className="mb-1 flex items-center gap-2">
        <Users className="h-4 w-4 text-[var(--primary)]" />
        <h2 className="text-base font-semibold">Teams</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Groups of people within this project. If the project is limited to its
        members (Settings → Visibility), being on the project is what grants
        access — teams organise the work rather than widening it.
        {!canManage && " You have read-only access here."}
      </p>

      {canManage && (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <Input
            aria-label="New team name"
            placeholder="New team name…"
            className="w-56"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createTeam();
            }}
          />
          <Button size="sm" onClick={createTeam} disabled={busy || !newName.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Create team
          </Button>
        </div>
      )}

      {teams.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
          No teams in this project yet.
        </p>
      ) : (
        <div className="space-y-3">
          {teams.map((t) => {
            const people = rosterFor(
              { id: t.id, name: t.name, members: t.members.map((m) => ({ projectMemberId: m.projectMemberId, isLead: m.isLead })) },
              roster,
            );
            return (
              <div key={t.id} className="rounded-lg border">
                <div className="flex items-center justify-between border-b px-4 py-2.5">
                  <div className="min-w-0">
                    <span className="text-sm font-medium">{t.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {people.length} {people.length === 1 ? "member" : "members"}
                    </span>
                  </div>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete team ${t.name}`}
                      disabled={busy}
                      onClick={() => deleteTeam(t.id, t.name)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  )}
                </div>

                <div className="divide-y">
                  {people.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-muted-foreground">
                      Nobody on this team yet.
                    </p>
                  ) : (
                    people.map((p) => (
                      <div key={p.id} className="flex items-center justify-between px-4 py-2">
                        <span className="flex items-center gap-1.5 truncate text-sm">
                          {p.displayName}
                          {p.isLead && (
                            <Crown
                              className="h-3 w-3 text-[var(--primary)]"
                              aria-label="Team lead"
                            />
                          )}
                        </span>
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove ${p.displayName} from ${t.name}`}
                            disabled={busy}
                            onClick={() => removeMember(t.id, p.id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {canManage && spare.length > 0 && (
                  <div className="border-t px-4 py-2.5">
                    {addingTo === t.id ? (
                      <SearchableSelect
                        aria-label={`Add someone to ${t.name}`}
                        className="w-full max-w-xs"
                        placeholder="Choose a project member…"
                        searchPlaceholder="Search people…"
                        emptyText="Nobody left to add"
                        value=""
                        onValueChange={(v) => v && addMember(t.id, v)}
                        options={spare.map((m) => ({ value: m.id, label: m.displayName }))}
                      />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => setAddingTo(t.id)}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add member
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canManage && teams.length > 0 && spare.length === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Everyone on this project is on a team. Add people to the project first
          to staff another one.
        </p>
      )}
    </section>
  );
}
