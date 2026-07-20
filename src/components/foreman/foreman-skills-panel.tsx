"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

/**
 * Foreman skills manager — create/import/manage the SKILL.md-style build
 * skills the build agent reads every pass (see ForemanHarnessPanel). Mirrors
 * ForemanSupervisorPanel's fetch/save idioms: GET the list on mount, mutate
 * via direct jsonFetch calls (no react-query mutations, thin), refetch after.
 * A skill with `orgId: null` is project-wide (applies to every org's
 * builds); one with `orgId` is scoped to this org only.
 */
interface SkillRow {
  id: string;
  orgId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  source: string;
}

export function ForemanSkillsPanel({ orgId }: { orgId: string }) {
  return (
    <SectionCard
      icon={BookOpen}
      title="Skills"
      description="Skills teach the build agent your conventions. Project skills apply to every build; org skills add to them."
    >
      <ForemanSkillsBody orgId={orgId} />
    </SectionCard>
  );
}

function ForemanSkillsBody({ orgId }: { orgId: string }) {
  const queryKey = useOrgQueryKey("foreman-skills");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<{ skills: SkillRow[] }>(`/api/v1/orgs/${orgId}/foreman/skills`),
  });
  const qc = useQueryClient();

  const [orgScope, setOrgScope] = useState(true);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [creating, setCreating] = useState(false);
  const [importBody, setImportBody] = useState("");
  const [importing, setImporting] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError || !data) {
    return <LoadError title="Couldn't load skills" onRetry={() => refetch()} />;
  }

  // Defensive: tolerate a fetch that resolves to a shape without `skills`
  // (e.g. a differently-shaped payload mid-refetch) rather than crashing the
  // whole console.
  const skills = data.skills ?? [];

  function withPending<T>(id: string, fn: () => Promise<T>): Promise<T> {
    setPendingIds((prev) => new Set(prev).add(id));
    return fn().finally(() => {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
  }

  async function toggleEnabled(skill: SkillRow) {
    try {
      await withPending(skill.id, () =>
        jsonFetch(`/api/v1/orgs/${orgId}/foreman/skills/${skill.id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: !skill.enabled }),
        }),
      );
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't update the skill.");
    }
  }

  async function deleteSkill(skill: SkillRow) {
    try {
      await withPending(skill.id, () =>
        jsonFetch(`/api/v1/orgs/${orgId}/foreman/skills/${skill.id}`, { method: "DELETE" }),
      );
      toast.success(`Deleted "${skill.name}".`);
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't delete the skill.");
    }
  }

  async function createSkill() {
    if (!createName.trim() || !createDescription.trim() || !createBody.trim()) return;
    setCreating(true);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/foreman/skills`, {
        method: "POST",
        body: JSON.stringify({
          mode: "create",
          name: createName,
          description: createDescription,
          body: createBody,
          orgScope,
        }),
      });
      toast.success("Skill created.");
      setCreateName("");
      setCreateDescription("");
      setCreateBody("");
      qc.invalidateQueries({ queryKey });
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't create the skill.");
    } finally {
      setCreating(false);
    }
  }

  async function importSkill() {
    if (!importBody.trim()) return;
    setImporting(true);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/foreman/skills`, {
        method: "POST",
        body: JSON.stringify({ mode: "import", body: importBody, orgScope }),
      });
      toast.success("Skill imported.");
      setImportBody("");
      qc.invalidateQueries({ queryKey });
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't import the skill.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        {skills.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No skills yet.</p>
        ) : (
          skills.map((skill) => (
            <div
              key={skill.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text)]">{skill.name}</span>
                  <Badge variant="neutral" showDot={false}>
                    {skill.orgId === null ? "Project" : "Org"}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">{skill.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ToggleSwitch
                  checked={skill.enabled}
                  onCheckedChange={() => toggleEnabled(skill)}
                  disabled={pendingIds.has(skill.id)}
                  aria-label={`Enable ${skill.name}`}
                />
                <ConfirmButton
                  onConfirm={() => deleteSkill(skill)}
                  pending={pendingIds.has(skill.id)}
                  size="sm"
                  variant="ghost"
                >
                  Delete
                </ConfirmButton>
              </div>
            </div>
          ))
        )}
      </div>

      <div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text)]">
          <Checkbox checked={orgScope} onChange={(e) => setOrgScope(e.target.checked)} />
          Apply to this org only
        </label>
        <p className="ml-6 text-xs text-[var(--text-muted)]">
          Checked: the skill applies to this org&apos;s builds only. Unchecked: it becomes a
          project skill, applying to every org&apos;s builds.
        </p>
      </div>

      <div className="rounded-lg border border-[var(--border)] p-3">
        <h4 className="mb-2 text-xs font-medium text-[var(--text-muted)]">Create a skill</h4>
        <div className="space-y-2">
          <Input
            aria-label="Skill name"
            placeholder="Name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
          />
          <Input
            aria-label="Skill description"
            placeholder="Description"
            value={createDescription}
            onChange={(e) => setCreateDescription(e.target.value)}
          />
          <Textarea
            aria-label="Skill body"
            placeholder="SKILL.md body — the instructions the build agent reads…"
            value={createBody}
            onChange={(e) => setCreateBody(e.target.value)}
            rows={5}
          />
          <Button onClick={createSkill} disabled={creating} size="sm">
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-[var(--border)] p-3">
        <h4 className="mb-2 text-xs font-medium text-[var(--text-muted)]">Import a SKILL.md</h4>
        <div className="space-y-2">
          <Textarea
            aria-label="SKILL.md to import"
            placeholder={"Paste a SKILL.md — with `---\\nname: ...\\ndescription: ...\\n---` frontmatter, or a leading `# Heading`…"}
            value={importBody}
            onChange={(e) => setImportBody(e.target.value)}
            rows={6}
          />
          <Button onClick={importSkill} disabled={importing} size="sm" variant="outline">
            {importing ? "Importing…" : "Import"}
          </Button>
        </div>
      </div>
    </div>
  );
}
