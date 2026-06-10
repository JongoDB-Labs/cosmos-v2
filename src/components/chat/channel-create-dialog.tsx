"use client";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Shape of /api/v1/orgs/[orgId]/projects — `success(projects)` returns a bare
// array (jsonFetch unwraps the `{ data }` envelope), so this is one element.
type OrgProject = {
  id: string;
  name: string;
  key: string;
};

// Shape of /api/v1/orgs/[orgId]/members — `success(members)` returns a bare
// array; the create API's `initialMemberIds` are matched against `userId`.
type OrgMemberLite = {
  id: string;
  userId: string;
  user: { id: string; displayName: string | null; email: string };
};

const NONE = "__none__";

/** Suggest a tidy channel slug from a project, e.g. "proj-fsc". */
function suggestNameForProject(p: OrgProject): string {
  const fromKey = p.key
    ? `proj-${p.key.toLowerCase()}`
    : p.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
  return fromKey.slice(0, 32);
}

export function ChannelCreateDialog({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const channelsKey = useOrgQueryKey("chat-channels");
  const projectsKey = useOrgQueryKey("projects");
  const membersKey = useOrgQueryKey("members");

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  // Tracks whether the user has hand-edited the name; once they have we stop
  // auto-suggesting from the selected project so we never clobber their input.
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [projectId, setProjectId] = useState<string>(NONE);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Both this dialog and the sidebar read projects through the same org-scoped
  // key, so React Query serves them from one cache entry (no duplicate fetch).
  // Only fetch once the dialog is open to keep the sidebar mount cheap.
  const { data: projects } = useQuery({
    queryKey: projectsKey,
    enabled: open,
    queryFn: () => jsonFetch<OrgProject[]>(`/api/v1/orgs/${orgId}/projects`),
    staleTime: 60_000,
  });

  const { data: members } = useQuery({
    queryKey: membersKey,
    enabled: open,
    queryFn: () => jsonFetch<OrgMemberLite[]>(`/api/v1/orgs/${orgId}/members`),
    staleTime: 60_000,
  });

  const memberList = useMemo(() => members ?? [], [members]);

  function resetForm() {
    setName("");
    setNameTouched(false);
    setDescription("");
    setIsPrivate(false);
    setProjectId(NONE);
    setMemberIds([]);
    setError(null);
  }

  function onProjectChange(value: string | null) {
    const next = value ?? NONE;
    setProjectId(next);
    // Prefill a suggested name when a project is picked and the user hasn't
    // typed their own. Keep it fully editable afterwards.
    if (next !== NONE && !nameTouched) {
      const proj = projects?.find((p) => p.id === next);
      if (proj) setName(suggestNameForProject(proj));
    }
  }

  function toggleMember(userId: string) {
    setMemberIds((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/chat/channels`, {
        method: "POST",
        body: JSON.stringify({
          name,
          description: description || undefined,
          isPrivate,
          projectId: projectId === NONE ? undefined : projectId,
          initialMemberIds: memberIds,
        }),
      });
      await qc.invalidateQueries({ queryKey: channelsKey });
      setOpen(false);
      resetForm();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create channel",
      );
      notifyError(err, "Failed to create channel");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      <DialogTrigger
        render={
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 text-left"
          />
        }
      >
        + New channel
      </DialogTrigger>
      <DialogContent className="w-96 max-w-[90vw]">
        <DialogTitle>New channel</DialogTitle>
        <form onSubmit={submit} className="space-y-3 mt-2">
          <input
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder="channel-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            maxLength={32}
            required
          />
          <input
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={512}
          />

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Project (optional)
            </label>
            <Select value={projectId} onValueChange={onProjectChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="No project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No project</SelectItem>
                {projects?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Members (optional)
            </label>
            {memberList.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No other members to add.
              </p>
            ) : (
              <div className="max-h-32 overflow-y-auto rounded border divide-y">
                {memberList.map((m) => {
                  const label = m.user.displayName || m.user.email;
                  return (
                    <label
                      key={m.userId}
                      className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer select-none hover:bg-accent"
                    >
                      <Checkbox
                        checked={memberIds.includes(m.userId)}
                        onChange={() => toggleMember(m.userId)}
                      />
                      <span className="truncate">{label}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {memberIds.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {memberIds.length} member
                {memberIds.length === 1 ? "" : "s"} will be added.
              </p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <Checkbox
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            Private channel (members-only)
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" disabled={busy || !name}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
