"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Copy, Layout, GripVertical } from "lucide-react";
import { WorkItemTypeIcon } from "@/components/work-items/work-item-type-icon";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

// ---- Types ----

interface BoardTemplateSummary {
  id: string;
  name: string;
  boardType: string;
  category: string;
  sortOrder: number;
  description: string;
  methodology: string | null;
}

interface WorkItemTypeSummary {
  id: string;
  key: string;
  name: string;
  pluralName: string | null;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  defaultParentTypeKey: string | null;
}

interface SerializableTemplate {
  id: string;
  orgId: string | null;
  slug: string;
  name: string;
  sector: string;
  description: string;
  isBuiltIn: boolean;
  defaultConfig: Record<string, unknown>;
  createdAt: string;
  boardTemplates: BoardTemplateSummary[];
  workItemTypes: WorkItemTypeSummary[];
}

interface TemplateEditorProps {
  template: SerializableTemplate;
  orgId: string;
  orgSlug: string;
}

// ---- Feature flags ----

const FEATURE_FLAGS = [
  { key: "goal", label: "Goals" },
  { key: "milestone", label: "Milestones" },
  { key: "kpi", label: "KPIs" },
  { key: "risk", label: "Risks" },
  { key: "decision", label: "Decisions" },
  { key: "meeting_note", label: "Meeting Notes" },
  { key: "okr", label: "OKRs" },
  { key: "cycle", label: "Cycles" },
] as const;

// ---- Board type badge ----

function boardTypeBadge(boardType: string) {
  const map: Record<string, "progress" | "review" | "done" | "strategic" | "neutral"> = {
    KANBAN: "progress",
    SCRUM: "review",
    LIST: "neutral",
    TIMELINE: "strategic",
    CALENDAR: "done",
  };
  return map[boardType.toUpperCase()] ?? "neutral";
}

// ---- Read-only banner for built-in templates ----

function ReadOnlyBanner({
  template,
  orgId,
  orgSlug,
}: {
  template: SerializableTemplate;
  orgId: string;
  orgSlug: string;
}) {
  const router = useRouter();
  const cloneMutation = useOrgMutation<SerializableTemplate, Error, void>({
    mutationFn: () =>
      jsonFetch<SerializableTemplate>(
        `/api/v1/orgs/${orgId}/project-templates/${template.id}/clone`,
        {
          method: "POST",
          body: JSON.stringify({ name: `${template.name} (copy)` }),
        }
      ),
    invalidate: [["project-templates"]],
    onSuccess: (newTemplate) => {
      toast.success("Template cloned — you can now edit it");
      router.push(`/${orgSlug}/settings/templates/${newTemplate.id}`);
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to clone template");
    },
  });

  return (
    <div className="mb-6 flex items-center justify-between gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
      <p className="text-sm text-[var(--text-muted)]">
        This is a <strong>built-in</strong> template and cannot be edited. Clone it to create an editable copy.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => cloneMutation.mutate()}
        disabled={cloneMutation.isPending}
        className="shrink-0 gap-1.5"
      >
        {cloneMutation.isPending ? <Loader2 className="animate-spin" /> : <Copy />}
        Clone to edit
      </Button>
    </div>
  );
}

// ---- Editable form ----

interface EditableFormProps {
  template: SerializableTemplate;
  orgId: string;
}

function EditableForm({ template, orgId }: EditableFormProps) {
  const [name, setName] = useState(template.name);
  const [sector, setSector] = useState(template.sector);
  const [description, setDescription] = useState(template.description);
  const [features, setFeatures] = useState<Record<string, boolean>>(
    () => {
      const config = template.defaultConfig;
      const enabledFeatures = (config.enabledFeatures as string[] | undefined) ?? [];
      return Object.fromEntries(FEATURE_FLAGS.map((f) => [f.key, enabledFeatures.includes(f.key)]));
    }
  );

  const saveMutation = useOrgMutation<SerializableTemplate, Error, void>({
    mutationFn: () =>
      jsonFetch<SerializableTemplate>(
        `/api/v1/orgs/${orgId}/project-templates/${template.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name,
            sector,
            description,
            defaultConfig: {
              ...template.defaultConfig,
              enabledFeatures: Object.entries(features)
                .filter(([, v]) => v)
                .map(([k]) => k),
            },
          }),
        }
      ),
    invalidate: [["project-templates"]],
    onSuccess: () => toast.success("Template saved"),
    onError: (err) => toast.error(err.message ?? "Failed to save"),
  });

  const toggleFeature = (key: string) =>
    setFeatures((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="space-y-8">
      {/* Metadata */}
      <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 space-y-5">
        <h2 className="text-base font-semibold text-[var(--text)]">Metadata</h2>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">Name</Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-sector">Sector</Label>
            <Input
              id="tpl-sector"
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              placeholder="e.g. tech, finance, healthcare"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tpl-description">Description</Label>
          <Textarea
            id="tpl-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe what this template is for..."
            className="min-h-20"
          />
        </div>

        <div className="space-y-2">
          <Label>Enabled features</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {FEATURE_FLAGS.map((f) => (
              <label
                key={f.key}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer transition-colors select-none",
                  features[f.key]
                    ? "border-[var(--primary)] bg-[color-mix(in_oklab,var(--primary)_8%,transparent)] text-[var(--text)]"
                    : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-[var(--primary)]/50"
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={!!features[f.key]}
                  onChange={() => toggleFeature(f.key)}
                />
                <span
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 rounded border flex items-center justify-center",
                    features[f.key]
                      ? "border-[var(--primary)] bg-[var(--primary)]"
                      : "border-[var(--border)]"
                  )}
                >
                  {features[f.key] && (
                    <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 10 10">
                      <path d="M1.5 5l2.5 2.5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                {f.label}
              </label>
            ))}
          </div>
        </div>
      </section>

      {/* Save */}
      <div className="flex justify-end">
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !name.trim()}
          className="gap-1.5"
        >
          {saveMutation.isPending && <Loader2 className="animate-spin" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}

// ---- Board templates list ----

function BoardTemplatesList({ boards }: { boards: BoardTemplateSummary[] }) {
  if (boards.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)] text-center py-6">
        No board templates attached.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-[var(--border)]">
      {boards.map((board) => (
        <li key={board.id} className="flex items-center gap-3 py-3">
          <GripVertical className="h-4 w-4 text-[var(--text-muted)] shrink-0 opacity-40" />
          <Layout className="h-4 w-4 text-[var(--text-muted)] shrink-0" />
          <span className="flex-1 text-sm font-medium text-[var(--text)]">{board.name}</span>
          <Badge variant={boardTypeBadge(board.boardType)} showDot={false}>
            {board.boardType}
          </Badge>
          {board.methodology && (
            <span className="text-xs text-[var(--text-muted)]">{board.methodology}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---- Work item types list ----

function WorkItemTypesList({ types }: { types: WorkItemTypeSummary[] }) {
  if (types.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)] text-center py-6">
        No work item types defined.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-[var(--border)]">
      {types.map((wit) => (
        <li key={wit.id} className="flex items-center gap-3 py-3">
          <GripVertical className="h-4 w-4 text-[var(--text-muted)] shrink-0 opacity-40" />
          <WorkItemTypeIcon
            icon={wit.icon}
            color={wit.color}
            className="h-4 w-4 shrink-0"
          />
          <span className="flex-1 text-sm font-medium text-[var(--text)]">
            {wit.name}
          </span>
          {wit.pluralName && (
            <span className="text-xs text-[var(--text-muted)]">plural: {wit.pluralName}</span>
          )}
          {wit.defaultParentTypeKey && (
            <Badge variant="neutral" showDot={false}>
              child of {wit.defaultParentTypeKey}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---- Main component ----

export function TemplateEditor({ template, orgId, orgSlug }: TemplateEditorProps) {
  return (
    <div className="mx-auto max-w-5xl p-8 space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link
          href={`/${orgSlug}/settings/templates`}
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "mt-0.5 shrink-0")}
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="sr-only">Back to gallery</span>
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold text-[var(--text)]">{template.name}</h1>
            <Badge variant="neutral" showDot={false}>{template.sector}</Badge>
            {template.isBuiltIn && (
              <Badge variant="strategic" showDot={false}>Built-in</Badge>
            )}
          </div>
          {template.description && (
            <p className="mt-1 text-sm text-[var(--text-muted)]">{template.description}</p>
          )}
        </div>
      </div>

      {/* Read-only banner for built-in */}
      {template.isBuiltIn && (
        <ReadOnlyBanner template={template} orgId={orgId} orgSlug={orgSlug} />
      )}

      {/* Editable form — only for org-owned templates */}
      {!template.isBuiltIn && <EditableForm template={template} orgId={orgId} />}

      {/* Board templates — read-only list */}
      <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-base font-semibold text-[var(--text)] mb-4">
          Board templates
          <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
            ({template.boardTemplates.length})
          </span>
        </h2>
        <BoardTemplatesList boards={template.boardTemplates} />
      </section>

      {/* Work item types — read-only list */}
      <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-base font-semibold text-[var(--text)] mb-4">
          Work item types
          <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
            ({template.workItemTypes.length})
          </span>
        </h2>
        <WorkItemTypesList types={template.workItemTypes} />
      </section>
    </div>
  );
}
