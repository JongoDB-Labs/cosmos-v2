"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Plus, Users } from "lucide-react";

interface BoardTab {
  id: string;
  name: string;
  type: string;
}

interface ProjectBoardTabsProps {
  orgSlug: string;
  projectKey: string;
  boards: BoardTab[];
  enabledFeatures?: string[];
  templateDefaultConfig?: Record<string, unknown> | null;
}

interface FeatureTab {
  feature: string;
  label: string;
  href: string;
}

export function ProjectBoardTabs({
  orgSlug,
  projectKey,
  boards,
  enabledFeatures = [],
  templateDefaultConfig,
}: ProjectBoardTabsProps) {
  const pathname = usePathname();

  const newBoardHref = `/${orgSlug}/projects/${projectKey}/boards/new`;

  // Derive cycle nav label from template config, fallback to "Sprints"
  const cycleNavLabel =
    typeof templateDefaultConfig?.cycleNavLabel === "string"
      ? templateDefaultConfig.cycleNavLabel
      : "Sprints";

  // Build feature tabs based on enabledFeatures
  const featureTabs: FeatureTab[] = [];

  if (enabledFeatures.includes("okr")) {
    featureTabs.push({
      feature: "okr",
      label: "OKRs",
      href: `/${orgSlug}/projects/${projectKey}/okrs`,
    });
  }

  if (enabledFeatures.includes("goal")) {
    featureTabs.push({
      feature: "goal",
      label: "Goals",
      href: `/${orgSlug}/projects/${projectKey}/goals`,
    });
  }

  if (enabledFeatures.includes("kpi")) {
    featureTabs.push({
      feature: "kpi",
      label: "KPIs",
      href: `/${orgSlug}/projects/${projectKey}/kpis`,
    });
  }

  if (enabledFeatures.includes("milestone")) {
    featureTabs.push({
      feature: "milestone",
      label: "Milestones",
      href: `/${orgSlug}/projects/${projectKey}/milestones`,
    });
  }

  const membersHref = `/${orgSlug}/projects/${projectKey}/members`;

  return (
    <div className="flex items-center gap-1 px-4 border-b overflow-x-auto">
      {boards.map((board) => {
        const href = `/${orgSlug}/projects/${projectKey}/boards/${board.id}`;
        const isActive = pathname === href;

        return (
          <Link
            key={board.id}
            href={href}
            className={cn(
              "relative px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {board.name}
            {isActive && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
            )}
          </Link>
        );
      })}

      {featureTabs.map((tab) => {
        const isActive = pathname === tab.href;

        return (
          <Link
            key={tab.feature}
            href={tab.href}
            className={cn(
              "relative px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
            {isActive && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
            )}
          </Link>
        );
      })}

      {/* Cycles tab — label driven by template config */}
      {enabledFeatures.includes("cycle") && (() => {
        const cyclesHref = `/${orgSlug}/projects/${projectKey}/cycles`;
        const isCyclesActive = pathname === cyclesHref;
        return (
          <Link
            key="cycle"
            href={cyclesHref}
            className={cn(
              "relative px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
              isCyclesActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {cycleNavLabel}
            {isCyclesActive && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
            )}
          </Link>
        );
      })()}

      <Link
        href={newBoardHref}
        aria-current={pathname === newBoardHref ? "page" : undefined}
        className={cn(
          "relative flex items-center gap-1 px-2 py-2 text-sm font-medium transition-colors whitespace-nowrap ml-1",
          pathname === newBoardHref
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Plus className="h-3.5 w-3.5" />
        New Board
        {pathname === newBoardHref && (
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
        )}
      </Link>

      {/* Members — project-scoped access (project managers + org admins). */}
      <Link
        href={membersHref}
        aria-current={pathname === membersHref ? "page" : undefined}
        className={cn(
          "relative ml-auto flex items-center gap-1 px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
          pathname === membersHref
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Users className="h-3.5 w-3.5" />
        Members
        {pathname === membersHref && (
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
        )}
      </Link>
    </div>
  );
}
