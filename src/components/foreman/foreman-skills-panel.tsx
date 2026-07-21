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
import { parseSkillMarkdown } from "@/lib/foreman/skill-import";

/**
 * Foreman skills manager — create/manage the SKILL.md-style build skills the
 * build agent reads every pass (see ForemanHarnessPanel). Mirrors
 * ForemanSupervisorPanel's fetch/save idioms: GET the list on mount, mutate
 * via direct jsonFetch calls (no react-query mutations, thin), refetch after.
 * A skill with `orgId: null` is project-wide (applies to every org's
 * builds); one with `orgId` is scoped to this org only.
 *
 * "Add skill" is a single flow with a Compose | Paste toggle: Compose edits
 * name/description/body directly; Paste lets you drop in a whole SKILL.md
 * and "Fill from paste" runs it through the pure `parseSkillMarkdown` parser
 * to populate the same Compose fields, then one "Add skill" button submits
 * either way via `createSkill`.
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
  const [addMode, setAddMode] = useState<"compose" | "paste">("compose");
  const [pasteBody, setPasteBody] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
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
      setPasteBody("");
      setPasteError(null);
      setAddMode("compose");
      qc.invalidateQueries({ queryKey });
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't create the skill.");
    } finally {
      setCreating(false);
    }
  }

  function fillFromPaste() {
    setPasteError(null);
    try {
      const parsed = parseSkillMarkdown(pasteBody);
      setCreateName(parsed.name);
      setCreateDescription(parsed.description);
      setCreateBody(parsed.body);
      setPasteBody("");
      setAddMode("compose");
    } catch (e) {
      setPasteError(e instanceof Error ? e.message : "Couldn't parse SKILL.md");
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
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-medium text-[var(--text-muted)]">Add skill</h4>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="xs"
              variant={addMode === "compose" ? "secondary" : "ghost"}
              aria-pressed={addMode === "compose"}
              onClick={() => setAddMode("compose")}
            >
              Compose
            </Button>
            <Button
              type="button"
              size="xs"
              variant={addMode === "paste" ? "secondary" : "ghost"}
              aria-pressed={addMode === "paste"}
              onClick={() => setAddMode("paste")}
            >
              Paste
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {addMode === "paste" && (
            <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2">
              <Textarea
                aria-label="Paste a SKILL.md"
                placeholder={
                  "Paste a SKILL.md — with `---\\nname: ...\\ndescription: ...\\n---` frontmatter, or a leading `# Heading`…"
                }
                value={pasteBody}
                onChange={(e) => setPasteBody(e.target.value)}
                rows={6}
              />
              {pasteError && (
                <p className="text-xs text-[var(--status-critical-text,var(--status-critical))]">
                  {pasteError}
                </p>
              )}
              <Button type="button" onClick={fillFromPaste} size="sm" variant="outline">
                Fill from paste
              </Button>
            </div>
          )}

          <Input
            aria-label="Name"
            placeholder="Name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
          />
          <Input
            aria-label="Description"
            placeholder="Description"
            value={createDescription}
            onChange={(e) => setCreateDescription(e.target.value)}
          />
          <Textarea
            aria-label="Body"
            placeholder="SKILL.md body — the instructions the build agent reads…"
            value={createBody}
            onChange={(e) => setCreateBody(e.target.value)}
            rows={5}
          />
          <Button onClick={createSkill} disabled={creating} size="sm">
            {creating ? "Adding…" : "Add skill"}
          </Button>
        </div>
      </div>
    </div>
  );
}
