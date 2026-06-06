"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, ChevronLeft, LayoutGrid } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { useOrgQueryKey } from "@/lib/query/keys";

interface BoardTemplate {
  id: string;
  name: string;
  boardType: string;
  sortOrder: number;
}

interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  boardTemplates: BoardTemplate[];
}

interface ProjectMetadataStepProps {
  orgId: string;
  orgSlug: string;
  templateId: string | null;
  sector: string | null;
  onBack: () => void;
}

function generateKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

export function ProjectMetadataStep({
  orgId,
  orgSlug,
  templateId,
  sector,
  onBack,
}: ProjectMetadataStepProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Fetch the selected template to show a board preview
  const templateQueryKey = useOrgQueryKey("project-template", templateId ?? "none");
  const { data: template, isLoading: templateLoading } = useQuery<ProjectTemplate>({
    queryKey: templateQueryKey,
    queryFn: () =>
      jsonFetch<ProjectTemplate>(
        `/api/v1/orgs/${orgId}/project-templates/${templateId}`,
      ),
    enabled: !!templateId,
  });

  type ProjectPayload = {
    name: string;
    key: string;
    description: string | null;
    templateId: string | null;
    sector: string | null;
  };

  const createProject = useOrgMutation<{ key: string }, Error, ProjectPayload>({
    mutationFn: (payload) =>
      jsonFetch<{ key: string }>(`/api/v1/orgs/${orgId}/projects`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    invalidate: [["projects"]],
    onSuccess: (project) => {
      router.push(`/${orgSlug}/projects/${project.key.toLowerCase()}`);
    },
    onError: (e) => setError(e.message),
  });

  const isPending = createProject.isPending;

  function clearFieldError(field: string) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function handleNameChange(value: string) {
    setName(value);
    clearFieldError("name");
    if (!keyEdited) {
      setKey(generateKey(value));
      // The auto-derived key changed too — clear any stale key error.
      clearFieldError("key");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    setError(null);

    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Project name is required";
    if (!key.trim()) next.key = "Project key is required";

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    createProject.mutate({
      name: name.trim(),
      key: key.trim().toUpperCase(),
      description: description.trim() || null,
      templateId: templateId ?? null,
      sector: sector ?? null,
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <p className="text-sm text-[var(--text-muted)]">
          Name your project and configure basic settings.
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <FormField label="Project name" required error={errors.name}>
              {(p) => (
                <Input
                  {...p}
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="My Project"
                  required
                  disabled={isPending}
                />
              )}
            </FormField>
            {name.trim() && (
              <p className="text-xs text-[var(--text-muted)]">
                Slug:{" "}
                <span className="font-mono">
                  {name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}
                </span>
              </p>
            )}
          </div>

          <div className="space-y-2">
            <FormField label="Project key" required error={errors.key}>
              {(p) => (
                <Input
                  {...p}
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                    setKeyEdited(true);
                    clearFieldError("key");
                  }}
                  placeholder="PROJ"
                  maxLength={10}
                  required
                  disabled={isPending}
                />
              )}
            </FormField>
            <p className="text-xs text-[var(--text-muted)]">
              Used as prefix for ticket numbers (e.g.,{" "}
              <span className="font-mono">{key || "PROJ"}-1</span>)
            </p>
          </div>

          <FormField label="Description (optional)">
            {(p) => (
              <Textarea
                {...p}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this project about?"
                rows={3}
                disabled={isPending}
              />
            )}
          </FormField>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push(`/${orgSlug}/projects`)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create project
            </Button>
          </div>
        </form>

        {/* Template preview panel */}
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Template
          </p>

          {!templateId && (
            <div className="mt-4 flex flex-col items-center gap-2 py-4 text-center">
              <LayoutGrid className="h-8 w-8 text-[var(--text-muted)]" />
              <p className="text-sm text-[var(--text-muted)]">
                Empty project — no boards pre-configured
              </p>
            </div>
          )}

          {templateId && templateLoading && (
            <div className="mt-4 space-y-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          )}

          {templateId && template && (
            <div className="mt-4 space-y-3">
              <p className="text-sm font-medium text-[var(--text)]">
                {template.name}
              </p>
              {template.description && (
                <p className="text-xs text-[var(--text-muted)]">
                  {template.description}
                </p>
              )}
              {template.boardTemplates.length > 0 && (
                <div className="space-y-1 border-t border-[var(--border)] pt-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Boards that will be created
                  </p>
                  <ul className="space-y-1">
                    {template.boardTemplates
                      .slice()
                      .sort((a, b) => a.sortOrder - b.sortOrder)
                      .map((board) => (
                        <li
                          key={board.id}
                          className="flex items-center gap-2 text-xs text-[var(--text)]"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />
                          {board.name}
                          <span className="ml-auto text-[var(--text-muted)]">
                            {board.boardType}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
