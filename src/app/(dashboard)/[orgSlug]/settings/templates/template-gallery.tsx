"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Loader2, Trash2, Pencil, Copy, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

// ---- Types ----

interface BoardTemplateSummary {
  id: string;
  name: string;
  boardType: string;
  sortOrder: number;
}

interface ProjectTemplate {
  id: string;
  name: string;
  slug: string;
  sector: string;
  description: string;
  isBuiltIn: boolean;
  orgId: string | null;
  boardTemplates: BoardTemplateSummary[];
  _count: { workItemTypes: number };
  createdAt: string;
}

// ---- Props ----

interface TemplateGalleryProps {
  orgId: string;
  orgSlug: string;
}

// ---- Sector badge variant mapping (visual only) ----

const SECTOR_VARIANTS: Record<string, "progress" | "review" | "done" | "blocked" | "strategic" | "discovery" | "neutral"> = {
  tech: "progress",
  finance: "done",
  healthcare: "strategic",
  education: "review",
  retail: "discovery",
  default: "neutral",
};

function sectorVariant(sector: string) {
  const key = sector.toLowerCase();
  return SECTOR_VARIANTS[key] ?? SECTOR_VARIANTS.default;
}

// ---- Clone dialog ----

function CloneDialog({
  open,
  onOpenChange,
  template,
  orgId,
  orgSlug,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  template: ProjectTemplate;
  orgId: string;
  orgSlug: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(`${template.name} (copy)`);

  const cloneMutation = useOrgMutation<ProjectTemplate, Error, string>({
    mutationFn: (cloneName) =>
      jsonFetch<ProjectTemplate>(
        `/api/v1/orgs/${orgId}/project-templates/${template.id}/clone`,
        { method: "POST", body: JSON.stringify({ name: cloneName }) }
      ),
    invalidate: [["project-templates"]],
    onSuccess: (newTemplate) => {
      toast.success("Template cloned successfully");
      onOpenChange(false);
      router.push(`/${orgSlug}/settings/templates/${newTemplate.id}`);
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to clone template");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clone template</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="clone-name">New template name</Label>
            <Input
              id="clone-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My custom template"
              autoFocus
            />
          </div>
        </div>
        <DialogFooter showCloseButton>
          <Button
            onClick={() => cloneMutation.mutate(name)}
            disabled={!name.trim() || cloneMutation.isPending}
          >
            {cloneMutation.isPending && <Loader2 className="animate-spin" />}
            Clone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Delete dialog ----

function DeleteDialog({
  open,
  onOpenChange,
  template,
  orgId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  template: ProjectTemplate;
  orgId: string;
}) {
  const queryClient = useQueryClient();
  const orgQueryKey = useOrgQueryKey("project-templates");
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/project-templates/${template.id}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body as { error?: string } | null)?.error ?? "Failed to delete template"
        );
      }
      toast.success("Template deleted");
      // Remove from cache immediately and refetch
      queryClient.setQueryData<ProjectTemplate[]>(orgQueryKey, (old) =>
        old ? old.filter((t) => t.id !== template.id) : []
      );
      await queryClient.invalidateQueries({ queryKey: orgQueryKey });
      onOpenChange(false);
      setConfirmText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete template");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setConfirmText("");
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete template?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-[var(--text-muted)]">
            This will permanently delete <strong>{template.name}</strong>. Projects using this template won&apos;t be affected.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="delete-template-confirm">
              Type <strong>{template.name}</strong> to confirm
            </Label>
            <Input
              id="delete-template-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={template.name}
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter showCloseButton>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={confirmText !== template.name || deleting}
          >
            {deleting && <Loader2 className="animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Template card ----

function TemplateCard({
  template,
  orgId,
  orgSlug,
}: {
  template: ProjectTemplate;
  orgId: string;
  orgSlug: string;
}) {
  const router = useRouter();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="flex flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 gap-3 hover:shadow-sm transition-shadow">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-[var(--text)] truncate">{template.name}</h3>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant={sectorVariant(template.sector)} showDot={false}>
              {template.sector}
            </Badge>
          </div>
        </div>
        {template.isBuiltIn && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] bg-[var(--bg-elevated)] rounded px-1.5 py-0.5">
            Built-in
          </span>
        )}
      </div>

      {/* Description */}
      {template.description && (
        <p className="text-sm text-[var(--text-muted)] line-clamp-2">
          {template.description}
        </p>
      )}

      {/* Stats */}
      <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
        <span>{template.boardTemplates.length} board{template.boardTemplates.length !== 1 ? "s" : ""}</span>
        <span>{template._count.workItemTypes} work item type{template._count.workItemTypes !== 1 ? "s" : ""}</span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1 border-t border-[var(--border)]">
        {template.isBuiltIn ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCloneOpen(true)}
            className="gap-1.5"
          >
            <Copy className="h-3.5 w-3.5" />
            Clone
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push(`/${orgSlug}/settings/templates/${template.id}`)}
              className="gap-1.5"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDeleteOpen(true)}
              className="gap-1.5 text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </>
        )}
      </div>

      {cloneOpen && (
        <CloneDialog
          open={cloneOpen}
          onOpenChange={setCloneOpen}
          template={template}
          orgId={orgId}
          orgSlug={orgSlug}
        />
      )}
      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        template={template}
        orgId={orgId}
      />
    </div>
  );
}

// ---- Minimal loading skeleton ----
// House pattern (see settings/webhooks-manager, security/classification-manager):
// one modest h-64 placeholder so real content grows DOWNWARD instead of the
// skeleton collapsing UPWARD. The toolbar above is always rendered for real.

function GallerySkeleton() {
  return <Skeleton className="h-64 rounded-lg" />;
}

// ---- Main component ----

type Tab = "built-in" | "org";

export function TemplateGallery({ orgId, orgSlug }: TemplateGalleryProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("built-in");
  const [sectorFilter, setSectorFilter] = useState<string>("");

  const queryKey = useOrgQueryKey("project-templates");
  const { data: templates, isLoading } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<ProjectTemplate[]>(`/api/v1/orgs/${orgId}/project-templates`),
  });

  // Create new template mutation
  const createMutation = useOrgMutation<ProjectTemplate, Error, void>({
    mutationFn: () =>
      jsonFetch<ProjectTemplate>(`/api/v1/orgs/${orgId}/project-templates`, {
        method: "POST",
        body: JSON.stringify({
          name: "New Template",
          sector: "tech",
          description: "",
        }),
      }),
    invalidate: [["project-templates"]],
    onSuccess: (newTemplate) => {
      toast.success("Template created");
      router.push(`/${orgSlug}/settings/templates/${newTemplate.id}`);
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to create template");
    },
  });

  // Derive sector list for filter
  const sectors = templates
    ? Array.from(new Set(templates.map((t) => t.sector))).sort()
    : [];

  const filtered = templates?.filter((t) => {
    const tabMatch = activeTab === "built-in" ? t.isBuiltIn : !t.isBuiltIn;
    const sectorMatch = !sectorFilter || t.sector === sectorFilter;
    return tabMatch && sectorMatch;
  }) ?? [];

  return (
    <div className="space-y-6">
      {/* Tab bar + actions */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-1">
          {(["built-in", "org"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                activeTab === tab
                  ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              )}
            >
              {tab === "built-in" ? "Built-in" : "Org templates"}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {/* Sector filter */}
          {sectors.length > 0 && (
            <Select
              items={{
                __all__: "All sectors",
                ...Object.fromEntries(sectors.map((s) => [s, s])),
              }}
              value={sectorFilter || "__all__"}
              onValueChange={(v) => setSectorFilter(v && v !== "__all__" ? v : "")}
            >
              <SelectTrigger size="sm" className="min-w-36" aria-label="Filter by sector">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All sectors</SelectItem>
                {sectors.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* New template — only in org tab */}
          {activeTab === "org" && (
            <Button
              size="sm"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
              className="gap-1.5"
            >
              {createMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Plus />
              )}
              New template
            </Button>
          )}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <GallerySkeleton />
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <LayoutGrid className="h-10 w-10 text-[var(--text-muted)] mb-3" />
          <p className="font-medium text-[var(--text)]">
            {activeTab === "org" ? "No org templates yet" : "No built-in templates found"}
          </p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {activeTab === "org"
              ? 'Click "New template" to create your first custom template.'
              : "Try changing the sector filter."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <TemplateCard key={t.id} template={t} orgId={orgId} orgSlug={orgSlug} />
          ))}
        </div>
      )}
    </div>
  );
}
