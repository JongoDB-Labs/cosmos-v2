"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ExternalLink,
  Settings,
  Archive,
  Trash2,
  CalendarClock,
  ListChecks,
  Repeat,
  Search,
  LayoutGrid,
  Rows3,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import { usePermissions } from "@/components/providers/permissions-provider";
import { Permission } from "@/lib/rbac/permissions";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { StaggeredGrid } from "@/components/ui/staggered-grid";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgMutation } from "@/lib/query/use-org-mutation";

export interface ProjectCardProject {
  id: string;
  key: string;
  name: string;
  archived: boolean;
  updatedAt: Date | string;
  totalItems: number;
  doneItems: number;
  percentComplete: number;
  lead: { displayName: string; avatarUrl: string | null } | null;
  activeCycleName: string | null;
  nextDueDate: Date | string | null;
}

interface ProjectCardProps {
  project: ProjectCardProject;
  orgSlug: string;
  orgId: string;
}

/** Color the progress bar/label by completion so the grid reads at a glance. */
function progressVariant(pct: number): BadgeVariant {
  if (pct >= 100) return "done";
  if (pct >= 60) return "progress";
  return "neutral";
}

/** Short, locale-aware due date (e.g. "Jun 14"). */
function formatDueDate(value: Date | string): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Whether a due date is in the past (overdue). */
function isOverdue(value: Date | string): boolean {
  return new Date(value).getTime() < Date.now();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("");
}

export function ProjectCard({ project, orgSlug, orgId }: ProjectCardProps) {
  const router = useRouter();
  const { can } = usePermissions();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const projectHref = `/${orgSlug}/projects/${project.key}`;

  // The project list is server-rendered via getActiveProjectsForOrg; the
  // route handlers already revalidate the org-projects cache tag, so a
  // router.refresh() re-fetches the updated server tree. invalidate also
  // clears any client-side ["projects"] query cache.
  const archiveMutation = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({ archived: true }),
      }),
    invalidate: [["projects"]],
    onSuccess: () => router.refresh(),
  });

  const deleteMutation = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/projects/${project.id}`, {
        method: "DELETE",
      }),
    invalidate: [["projects"]],
    onSuccess: () => {
      setShowDeleteDialog(false);
      router.refresh();
    },
  });

  const menuGroups = useMemo<ActionMenuGroup[]>(() => {
    const navGroup: ActionMenuGroup = {
      items: [
        {
          label: "Open",
          icon: ExternalLink,
          onClick: () => router.push(projectHref),
        },
        ...(can(Permission.PROJECT_MANAGE)
          ? [
              {
                label: "Settings",
                icon: Settings,
                onClick: () =>
                  router.push(`${projectHref}/settings`),
              },
            ]
          : []),
      ],
    };

    const dangerGroup: ActionMenuGroup = {
      items: [
        ...(can(Permission.PROJECT_UPDATE)
          ? [
              {
                label: "Archive",
                icon: Archive,
                disabled: archiveMutation.isPending,
                onClick: () => archiveMutation.mutate(),
              },
            ]
          : []),
        ...(can(Permission.PROJECT_DELETE)
          ? [
              {
                label: "Delete",
                icon: Trash2,
                variant: "destructive" as const,
                onClick: () => setShowDeleteDialog(true),
              },
            ]
          : []),
      ],
    };

    return [navGroup, dangerGroup];
  }, [can, projectHref, router, archiveMutation]);

  return (
    <>
      <ActionMenu groups={menuGroups}>
        <div className="group/action relative">
          <Link
            href={projectHref}
            className="block rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 transition-shadow hover:shadow-[var(--shadow-glow)]"
          >
            <div className="mb-3 flex items-center gap-2">
              <div className="h-7 w-7 rounded bg-[var(--primary-tint)] flex items-center justify-center text-xs font-semibold text-[var(--primary)]">
                {project.name.charAt(0).toUpperCase()}
              </div>
              <h3 className="font-medium truncate flex-1 text-[var(--text)]">{project.name}</h3>
              {project.lead && (
                <Avatar size="sm" title={`Lead: ${project.lead.displayName}`}>
                  {project.lead.avatarUrl && (
                    <AvatarImage
                      src={project.lead.avatarUrl}
                      alt={project.lead.displayName}
                    />
                  )}
                  <AvatarFallback>
                    {initials(project.lead.displayName)}
                  </AvatarFallback>
                </Avatar>
              )}
            </div>

            {/* Real progress — done / total work items. */}
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-[var(--text-muted)]">
                <ListChecks className="h-3.5 w-3.5" />
                {project.totalItems === 0
                  ? "No items"
                  : `${project.doneItems}/${project.totalItems} done`}
              </span>
              <span className="font-medium tabular-nums text-[var(--text-muted)]">
                {project.percentComplete}%
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--primary-tint)]">
              <div
                className="h-full rounded-full bg-[var(--primary)] transition-[width]"
                style={{ width: `${project.percentComplete}%` }}
              />
            </div>

            {/* Status chips: active cycle, next due, completion. */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Badge variant={progressVariant(project.percentComplete)}>
                {project.archived
                  ? "Archived"
                  : project.percentComplete >= 100
                    ? "Complete"
                    : project.totalItems === 0
                      ? "Empty"
                      : "Active"}
              </Badge>
              {project.activeCycleName && (
                <Badge variant="strategic" showDot={false}>
                  <Repeat className="h-3 w-3" />
                  {project.activeCycleName}
                </Badge>
              )}
              {project.nextDueDate && (
                <Badge
                  variant={
                    isOverdue(project.nextDueDate) ? "blocked" : "neutral"
                  }
                  showDot={false}
                >
                  <CalendarClock className="h-3 w-3" />
                  {formatDueDate(project.nextDueDate)}
                </Badge>
              )}
            </div>

            <p className="mt-3 text-xs text-[var(--text-muted)]">
              Updated {new Date(project.updatedAt).toLocaleDateString()}
            </p>
          </Link>
        </div>
      </ActionMenu>

      <Dialog
        open={showDeleteDialog}
        onOpenChange={(open) => {
          if (!open) setShowDeleteDialog(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium">{project.name}</span> and all of its
              boards, cycles, and work items. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Portfolio view — header controls (search / status filter / view toggle) plus
// the card grid and a compact sortable table. Rendered by the Projects list
// page (a server component) which fetches the enriched project rollups.
// ---------------------------------------------------------------------------

type StatusFilter = "active" | "archived" | "all";
type ViewMode = "cards" | "table";
type SortKey = "name" | "percentComplete" | "totalItems" | "updatedAt";
type SortDir = "asc" | "desc";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

export function ProjectsPortfolio({
  projects,
  orgSlug,
  orgId,
}: {
  projects: ProjectCardProject[];
  orgSlug: string;
  orgId: string;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [view, setView] = useState<ViewMode>("cards");
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (status === "active" && p.archived) return false;
      if (status === "archived" && !p.archived) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.key.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [projects, search, status]);

  const sorted = useMemo(() => {
    const factor = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "percentComplete":
          cmp = a.percentComplete - b.percentComplete;
          break;
        case "totalItems":
          cmp = a.totalItems - b.totalItems;
          break;
        case "updatedAt":
          cmp =
            new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          break;
      }
      return cmp * factor;
    });
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Names read best A→Z; numeric/recency columns default high→low.
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
            className="pl-8"
          />
        </div>

        <Select
          value={status}
          onValueChange={(v) => setStatus((v as StatusFilter) ?? "active")}
        >
          <SelectTrigger aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div
          role="group"
          aria-label="View mode"
          className="ml-auto inline-flex items-center gap-0.5 rounded-lg border border-[var(--border)] p-0.5"
        >
          <Button
            variant={view === "cards" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Card view"
            aria-pressed={view === "cards"}
            onClick={() => setView("cards")}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={view === "table" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Table view"
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
          >
            <Rows3 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          title="No projects match"
          description={
            search.trim()
              ? "Try a different search term or status filter."
              : "No projects in this view."
          }
        />
      ) : view === "cards" ? (
        <StaggeredGrid className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sorted.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              orgSlug={orgSlug}
              orgId={orgId}
            />
          ))}
        </StaggeredGrid>
      ) : (
        <ProjectsTable
          projects={sorted}
          orgSlug={orgSlug}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={toggleSort}
        />
      )}
    </div>
  );
}

function SortHeader({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sortKey === column;
  return (
    <th
      className={cn("px-3 py-2 text-left font-medium", className)}
      aria-sort={
        active ? (sortDir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
      >
        {label}
        {active &&
          (sortDir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          ))}
      </button>
    </th>
  );
}

function ProjectsTable({
  projects,
  orgSlug,
  sortKey,
  sortDir,
  onSort,
}: {
  projects: ProjectCardProject[];
  orgSlug: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const router = useRouter();
  return (
    <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-sm">
        <thead className="border-b border-[var(--border)] text-xs">
          <tr>
            <SortHeader
              label="Name"
              column="name"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
            />
            <SortHeader
              label="Progress"
              column="percentComplete"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              className="w-48"
            />
            <SortHeader
              label="Items"
              column="totalItems"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              className="w-24"
            />
            <SortHeader
              label="Updated"
              column="updatedAt"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              className="w-32"
            />
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr
              key={p.id}
              onClick={() => router.push(`/${orgSlug}/projects/${p.key}`)}
              className="cursor-pointer border-b border-[var(--border)] last:border-0 transition-colors hover:bg-[var(--primary-tint)]/40"
            >
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--primary-tint)] text-xs font-semibold text-[var(--primary)]">
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="truncate font-medium">{p.name}</span>
                  {p.archived && (
                    <Badge variant="neutral" showDot={false}>
                      Archived
                    </Badge>
                  )}
                </div>
              </td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--primary-tint)]">
                    <div
                      className="h-full rounded-full bg-[var(--primary)]"
                      style={{ width: `${p.percentComplete}%` }}
                    />
                  </div>
                  <span className="tabular-nums text-xs text-[var(--text-muted)]">
                    {p.percentComplete}%
                  </span>
                </div>
              </td>
              <td className="px-3 py-2.5 tabular-nums text-[var(--text-muted)]">
                {p.doneItems}/{p.totalItems}
              </td>
              <td className="px-3 py-2.5 text-[var(--text-muted)]">
                {new Date(p.updatedAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
