"use client";

import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { LayoutGrid, ChevronLeft } from "lucide-react";

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
  sector: string;
  isBuiltIn: boolean;
  boardTemplates: BoardTemplate[];
  _count: { workItemTypes: number };
}

interface TemplatePickerProps {
  orgId: string;
  sector: string | null;
  onSelect: (templateId: string | null) => void;
  onBack: () => void;
}

export function TemplatePicker({
  orgId,
  sector,
  onSelect,
  onBack,
}: TemplatePickerProps) {
  const queryKey = useOrgQueryKey(
    "project-templates",
    sector ?? "all",
  );

  const { data: templates, isLoading, isError } = useQuery<ProjectTemplate[]>({
    queryKey,
    queryFn: () => {
      const url = sector
        ? `/api/v1/orgs/${orgId}/project-templates?sector=${encodeURIComponent(sector)}`
        : `/api/v1/orgs/${orgId}/project-templates`;
      return jsonFetch<ProjectTemplate[]>(url);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <p className="text-sm text-[var(--text-muted)]">
          {sector
            ? `Choose a template for your ${sector} project.`
            : "Choose any template or start with an empty project."}
        </p>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p className="text-sm text-destructive">
          Failed to load templates. Please try again.
        </p>
      )}

      {!isLoading && !isError && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Empty project card — always first */}
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={cn(
              "flex flex-col gap-3 rounded-[var(--radius)] border border-dashed border-[var(--border)]",
              "bg-[var(--surface)] p-5 text-left transition-all",
              "hover:border-[var(--primary)] hover:shadow-[var(--shadow-glow)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
            )}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--primary)]/10">
              <LayoutGrid className="h-5 w-5 text-[var(--primary)]" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[var(--text)]">
                Empty project
              </p>
              <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                No boards or tracking types — configure everything yourself
              </p>
            </div>
          </button>

          {(templates ?? []).map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => onSelect(template.id)}
              className={cn(
                "flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)]",
                "bg-[var(--surface)] p-5 text-left transition-all",
                "hover:border-[var(--primary)] hover:shadow-[var(--shadow-glow)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
              )}
            >
              <div className="space-y-1">
                <p className="text-sm font-semibold text-[var(--text)]">
                  {template.name}
                  {template.isBuiltIn && (
                    <span className="ml-2 rounded-full bg-[var(--primary)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--primary)]">
                      Built-in
                    </span>
                  )}
                </p>
                {template.description && (
                  <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                    {template.description}
                  </p>
                )}
              </div>
              {template.boardTemplates.length > 0 && (
                <div className="mt-auto pt-2 border-t border-[var(--border)]">
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {template.boardTemplates.length}{" "}
                    {template.boardTemplates.length === 1 ? "board" : "boards"}
                    {template._count.workItemTypes > 0
                      ? ` · ${template._count.workItemTypes} work item types`
                      : ""}
                  </p>
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
