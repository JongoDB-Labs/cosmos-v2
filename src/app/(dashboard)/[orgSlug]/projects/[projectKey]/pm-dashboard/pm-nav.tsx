"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Sub-navigation inside the PM Dashboard. The registers used to be top-level
 * project tabs (which crowded the board strip); they now live here as sub-tabs
 * of the dashboard, mirroring the original tracker layout. Items are gated by
 * the project's enabled features.
 */
const ITEMS: { feature: string | null; label: string; seg: string }[] = [
  { feature: null, label: "Overview", seg: "" },
  { feature: "risk-register", label: "Risk Register", seg: "/risks" },
  { feature: "change-log", label: "Change Log", seg: "/changes" },
  { feature: "blocked-items", label: "Blocked Items", seg: "/blockers" },
  { feature: "schedule-variance", label: "Schedule", seg: "/schedule" },
  { feature: "deliverables-tracker", label: "Deliverables", seg: "/deliverables" },
  { feature: "vendors", label: "Vendors", seg: "/vendors" },
  { feature: "staffing", label: "Staffing", seg: "/staffing" },
  { feature: "clin-burn", label: "CLIN Burn", seg: "/clins" },
];

export function PmDashboardNav({
  orgSlug,
  projectKey,
  enabledFeatures,
}: {
  orgSlug: string;
  projectKey: string;
  enabledFeatures: string[];
}) {
  const pathname = usePathname();
  const base = `/${orgSlug}/projects/${projectKey}/pm-dashboard`;
  const items = ITEMS.filter((i) => i.feature === null || enabledFeatures.includes(i.feature));

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b bg-muted/30 px-4">
      {items.map((i) => {
        const href = base + i.seg;
        const isActive = pathname === href;
        return (
          <Link
            key={i.seg || "overview"}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative whitespace-nowrap px-3 py-2 text-sm font-medium transition-colors",
              isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {i.label}
            {isActive && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary" />
            )}
          </Link>
        );
      })}
    </div>
  );
}
