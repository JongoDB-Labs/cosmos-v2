"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hash } from "lucide-react";
import { SectionCard } from "@/components/ui/section-card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import {
  applyNamePattern,
  formatProjectNumber,
  validateNamePattern,
  validatePattern,
  type ProjectNumbering,
} from "@/lib/projects/numbering";

type Data = ProjectNumbering & { next: string | null; canManage: boolean };

/**
 * The org's project numbering standard: the pattern new projects are numbered
 * from (e.g. YY-NNN) and an optional naming pattern. Shown to whoever may
 * change org settings.
 */
export function ProjectNumberingCard({ orgId }: { orgId: string }) {
  const { data } = useQuery({
    queryKey: useOrgQueryKey("project-numbering"),
    queryFn: () => jsonFetch<Data>(`/api/v1/orgs/${orgId}/project-numbering`),
  });
  const save = useOrgMutation({
    mutationFn: (patch: Partial<ProjectNumbering>) =>
      jsonFetch(`/api/v1/orgs/${orgId}/project-numbering`, { method: "PUT", body: JSON.stringify(patch) }),
    invalidate: [["project-numbering"]],
    onError: (e) => notifyError(e, "Couldn't change project numbering."),
  });
  if (!data?.canManage) return null;
  return (
    <SectionCard
      icon={Hash}
      title="Project numbers"
      description="Number new projects automatically from a year-based sequence."
    >
      <NumberingEditor
        key={`${data.pattern}\n${data.namePattern}`}
        initial={data}
        pending={save.isPending}
        onSave={(patch) => save.mutate(patch)}
      />
    </SectionCard>
  );
}

function NumberingEditor({
  initial,
  pending,
  onSave,
}: {
  initial: Data;
  pending: boolean;
  onSave: (patch: ProjectNumbering) => void;
}) {
  const [pattern, setPattern] = useState(initial.pattern ?? "");
  const [namePattern, setNamePattern] = useState(initial.namePattern ?? "");
  const p = pattern.trim();
  const np = namePattern.trim();
  const patternError = p ? validatePattern(p) : null;
  const nameError = np ? validateNamePattern(np) : null;
  const changed = p !== (initial.pattern ?? "") || np !== (initial.namePattern ?? "");
  // The example uses this year and the first number, so it reads the same
  // whether or not the org already has projects.
  const example = p && !patternError ? formatProjectNumber(p, new Date().getFullYear(), 1) : null;
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1">
        <label htmlFor="project-number-pattern">Number pattern</label>
        <span className="block text-xs text-muted-foreground">
          YY or YYYY for the year, a run of N for the sequence (it restarts each year). Leave empty to stop numbering.
        </span>
        <Input
          id="project-number-pattern"
          value={pattern}
          placeholder="YY-NNN"
          onChange={(e) => setPattern(e.target.value)}
          disabled={pending}
          aria-invalid={!!patternError}
        />
        {patternError ? (
          <p className="text-xs text-destructive">{patternError}</p>
        ) : example ? (
          <p className="text-xs text-muted-foreground">
            The first project this year would be <span className="font-mono">{example}</span>
            {initial.pattern === p && initial.next ? (
              <>
                ; the next one is <span className="font-mono">{initial.next}</span>
              </>
            ) : null}
            .
          </p>
        ) : null}
      </div>
      <div className="space-y-1">
        <label htmlFor="project-name-pattern">Naming pattern (optional)</label>
        <span className="block text-xs text-muted-foreground">
          Applied to a new project&apos;s name. Use {"{number}"} and {"{name}"}, e.g. {"{number} {name}"}.
        </span>
        <Input
          id="project-name-pattern"
          value={namePattern}
          placeholder="{number} {name}"
          onChange={(e) => setNamePattern(e.target.value)}
          disabled={pending}
          aria-invalid={!!nameError}
        />
        {nameError ? (
          <p className="text-xs text-destructive">{nameError}</p>
        ) : np && example ? (
          <p className="text-xs text-muted-foreground">
            e.g. {applyNamePattern(np, { name: "Riverside Library", number: example })}
          </p>
        ) : null}
      </div>
      <Button
        size="sm"
        onClick={() => onSave({ pattern: p || null, namePattern: np || null })}
        disabled={pending || !changed || !!patternError || !!nameError}
      >
        Save
      </Button>
    </div>
  );
}
