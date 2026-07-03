"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { LoadError } from "@/components/ui/load-error";
import {
  Columns3,
  Timer,
  ListOrdered,
  Table2,
  GanttChart,
  Map,
  CalendarDays,
  Target,
  LayoutGrid,
  BarChart3,
  ShieldAlert,
  AreaChart,
  Network,
  Loader2,
  type LucideIcon,
} from "lucide-react";

const iconMap: Record<string, LucideIcon> = {
  Columns3,
  Timer,
  ListOrdered,
  Table2,
  GanttChart,
  Map,
  CalendarDays,
  Target,
  LayoutGrid,
  BarChart3,
  ShieldAlert,
  AreaChart,
  Network,
};

interface BoardTemplate {
  slug: string;
  name: string;
  category: string;
  methodology?: string;
  description: string;
  icon: string;
  /** Present for board-type templates (creates a Board row). */
  boardType?: string;
  /** Optional board config seed (e.g. a TIMELINE template that opens as the
   *  static "release-timeline" variant). */
  config?: Record<string, unknown>;
  /** Present for FEATURE views (e.g. "pm-dashboard"): selecting enables the
   *  project feature flag + opens that view instead of creating a board. */
  feature?: string;
}

/** Feature key → the project sub-route segment to open after enabling it. */
const FEATURE_ROUTE_SEGMENT: Record<string, string> = {
  "pm-dashboard": "pm-dashboard",
};

const categories = [
  "all",
  "agile",
  "planning",
  "strategy",
  "analytics",
  "tracking",
  "enterprise",
] as const;

const categoryLabels: Record<string, string> = {
  all: "All",
  agile: "Agile",
  planning: "Planning",
  strategy: "Strategy",
  analytics: "Analytics",
  tracking: "Tracking",
  enterprise: "Enterprise",
};

interface TemplateGalleryProps {
  orgId: string;
  projectId: string;
  orgSlug: string;
  projectKey: string;
  /** The project's currently-enabled feature flags (for feature-view cards). */
  enabledFeatures?: string[];
}

export function TemplateGallery({
  orgId,
  projectId,
  orgSlug,
  projectKey,
  enabledFeatures = [],
}: TemplateGalleryProps) {
  const router = useRouter();
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [creatingSlug, setCreatingSlug] = useState<string | null>(null);
  const [templates, setTemplates] = useState<BoardTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoadingTemplates(true);
    setLoadError(false);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/templates/built-in`);
      if (!res.ok) throw new Error();
      const json = await res.json();
      setTemplates(Array.isArray(json) ? json : json.data ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoadingTemplates(false);
    }
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const filtered =
    activeCategory === "all"
      ? templates
      : templates.filter((t) => t.category === activeCategory);

  function handleSelect(template: BoardTemplate) {
    if (creatingSlug) return;
    if (template.feature) void handleEnableFeature(template);
    else void handleCreate(template);
  }

  // Feature-view card (e.g. PM Dashboard): enable the project feature flag (if not
  // already on) and open that view, instead of creating a Board row.
  async function handleEnableFeature(template: BoardTemplate) {
    const feature = template.feature!;
    const segment = FEATURE_ROUTE_SEGMENT[feature] ?? feature;
    const target = `/${orgSlug}/projects/${projectKey}/${segment}`;
    setCreatingSlug(template.slug);
    try {
      if (!enabledFeatures.includes(feature)) {
        const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // The PUT replaces+filters enabledFeatures to the known toggleable set,
          // so send the union of current + the new feature.
          body: JSON.stringify({ enabledFeatures: [...enabledFeatures, feature] }),
        });
        if (!res.ok) throw new Error("Failed to enable feature");
        toast.success(`${template.name} enabled`);
      }
      router.push(target);
    } catch (err) {
      notifyError(err, `Couldn't enable ${template.name}.`);
      setCreatingSlug(null);
    }
  }

  async function handleCreate(template: BoardTemplate) {
    setCreatingSlug(template.slug);

    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/boards`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: template.name,
            type: template.boardType,
            ...(template.config ? { config: template.config } : {}),
          }),
        }
      );

      if (!res.ok) throw new Error("Failed to create board");

      const board = await res.json();
      toast.success("Board created");
      router.push(
        `/${orgSlug}/projects/${projectKey}/boards/${board.slug ?? board.id}`
      );
      // The board-tabs strip is rendered from the project layout's server-side
      // Prisma query, so a client push() alone navigates to the new board while
      // the tabs still show the stale list. Refresh re-runs the layout so the
      // new board appears in the tabs without a manual reload.
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't create the board.");
      setCreatingSlug(null);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto">
      <div>
        <h2 className="text-xl font-semibold">New Board</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose a template to get started
        </p>
      </div>

      {/* Category filter tabs */}
      <div className="flex items-center gap-1 overflow-x-auto">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={cn(
              "px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap",
              activeCategory === cat
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {categoryLabels[cat]}
          </button>
        ))}
      </div>

      {/* Template cards grid */}
      {loadingTemplates ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <LoadError onRetry={() => { void load(); }} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((template) => {
            const Icon = iconMap[template.icon] ?? LayoutGrid;
            const isCreating = creatingSlug === template.slug;

            return (
              <button
                key={template.slug}
                onClick={() => handleSelect(template)}
                disabled={creatingSlug !== null}
                className={cn(
                  "group relative flex flex-col gap-3 rounded-lg border p-4 text-left transition-all",
                  "hover:border-primary/50 hover:shadow-sm",
                  "disabled:opacity-60 disabled:cursor-not-allowed",
                  isCreating && "border-primary/50 shadow-sm"
                )}
              >
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                    {isCreating ? (
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    ) : (
                      <Icon className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {template.methodology && (
                      <Badge variant="neutral" className="text-[10px] uppercase tracking-wider">
                        {template.methodology}
                      </Badge>
                    )}
                    <Badge variant="neutral" showDot={false} className="text-[10px] capitalize">
                      {template.category}
                    </Badge>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-medium">{template.name}</h3>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {template.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
