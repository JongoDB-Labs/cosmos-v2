"use client";

/**
 * Save a filter, or edit one's details: name, description, who can see it
 * (only me / a team / a project / everyone) and who else may edit it.
 *
 * "Everyone in the organization" needs FILTER_SHARE_ORG; the option says so
 * rather than failing on save. A team or project is picked from the ones the
 * viewer can see; the server re-checks all of it.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { useProjectTeams } from "@/hooks/use-project-teams";
import { apiErrorText, useSavedFilterMutations, type SavedFilter, type Visibility } from "./use-saved-filters";

export interface SaveFilterDialogProps {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this filter's details; omit to save a new one. */
  filter?: SavedFilter;
  /** The query to save (new filters only). */
  cql?: string;
  projects: { id: string; key: string; name: string }[];
  members: { id: string; displayName: string }[];
  onSaved?: (f: SavedFilter) => void;
}

const VISIBILITY: { value: Visibility; label: string; hint: string }[] = [
  { value: "PRIVATE", label: "Only me", hint: "Plus anyone you add as an editor." },
  { value: "TEAM", label: "A team", hint: "Members of the team who can see its project." },
  { value: "PROJECT", label: "A project", hint: "Everyone who can see the project." },
  { value: "ORG", label: "Everyone in the organization", hint: "Shows under Shared with me for every member." },
];

export function SaveFilterDialog(props: SaveFilterDialogProps) {
  // Remount per open so the form starts from the filter (or blank) each time.
  return props.open ? <SaveFilterForm key={props.filter?.id ?? "new"} {...props} /> : <Dialog open={false} />;
}

function SaveFilterForm({ orgId, open, onOpenChange, filter, cql, projects, members, onSaved }: SaveFilterDialogProps) {
  const { can } = usePermissions();
  const mayShareOrg = can(Permission.FILTER_SHARE_ORG);
  const { create, update } = useSavedFilterMutations(orgId);
  const [name, setName] = useState(filter?.name ?? "");
  const [description, setDescription] = useState(filter?.description ?? "");
  const [visibility, setVisibility] = useState<Visibility>(filter?.visibility ?? "PRIVATE");
  const [projectId, setProjectId] = useState<string | null>(filter?.project?.id ?? null);
  const [teamId, setTeamId] = useState<string | null>(filter?.team?.id ?? null);
  const [editorIds, setEditorIds] = useState<string[]>(filter?.editors.map((e) => e.id) ?? []);
  const [error, setError] = useState<string | null>(null);
  const teams = useProjectTeams(orgId, visibility === "TEAM" ? (projectId ?? "") : "");
  const ownerish = !filter || filter.mine || filter.canDelete;
  const pending = create.isPending || update.isPending;

  const missing =
    !name.trim()
      ? "Give the filter a name."
      : (visibility === "PROJECT" || visibility === "TEAM") && !projectId
        ? "Pick the project."
        : visibility === "TEAM" && !teamId
          ? "Pick the team."
          : null;

  async function save() {
    if (missing) return setError(missing);
    setError(null);
    const access = ownerish
      ? {
          visibility,
          projectId: visibility === "PROJECT" ? projectId : null,
          teamId: visibility === "TEAM" ? teamId : null,
          editorIds,
        }
      : {};
    try {
      const saved = filter
        ? await update.mutateAsync({ id: filter.id, name: name.trim(), description: description.trim(), ...access })
        : await create.mutateAsync({ name: name.trim(), description: description.trim(), cql: cql ?? "", ...access });
      toast.success(filter ? `Updated "${saved.name}"` : `Saved "${saved.name}"`);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (e) {
      setError(apiErrorText(e, "Couldn't save the filter."));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{filter ? "Edit filter" : "Save filter"}</DialogTitle>
          <DialogDescription>
            {filter ? "Change the name, description and who can see or edit it." : "Save this query so you, or others, can run it again."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="sf-name">Name</Label>
            <Input id="sf-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sf-desc">Description</Label>
            <Textarea id="sf-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
          </div>
          {ownerish && (
            <>
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">Who can see it</legend>
                {VISIBILITY.map((v) => {
                  const off = v.value === "ORG" && !mayShareOrg && filter?.visibility !== "ORG";
                  return (
                    <label key={v.value} className={`flex items-start gap-2 text-sm ${off ? "opacity-50" : ""}`}>
                      <input
                        type="radio"
                        name="sf-visibility"
                        value={v.value}
                        checked={visibility === v.value}
                        disabled={off}
                        onChange={() => setVisibility(v.value)}
                        className="mt-1"
                      />
                      <span>
                        {v.label}
                        <span className="block text-xs text-[var(--text-muted)]">
                          {off ? "Needs the Share filters with the org permission." : v.hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
              {(visibility === "PROJECT" || visibility === "TEAM") && (
                <SearchableSelect
                  value={projectId}
                  onValueChange={(v) => {
                    setProjectId(v);
                    setTeamId(null);
                  }}
                  options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
                  placeholder="Project"
                  aria-label="Project"
                />
              )}
              {visibility === "TEAM" && projectId && (
                <SearchableSelect
                  value={teamId}
                  onValueChange={setTeamId}
                  options={(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
                  placeholder={teams.isLoading ? "Loading teams…" : "Team"}
                  emptyText="This project has no teams"
                  aria-label="Team"
                />
              )}
              <div className="space-y-1">
                <Label>Editors</Label>
                <SearchableMultiSelect
                  value={editorIds}
                  onValueChange={setEditorIds}
                  options={members.map((m) => ({ value: m.id, label: m.displayName }))}
                  placeholder="Only the owner"
                  aria-label="Editors"
                />
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-[var(--status-blocked-text)]">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
