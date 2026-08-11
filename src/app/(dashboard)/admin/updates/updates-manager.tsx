"use client";

import { useQuery } from "@tanstack/react-query";
import { Package, CheckCircle2, AlertTriangle, XCircle, HelpCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { cn } from "@/lib/utils";

type PreflightStatus = "pass" | "warn" | "fail" | "unknown";

type Preflight = {
  id: string;
  title: string;
  status: PreflightStatus;
  detail: string;
  blocking: boolean;
};

type UpdateCheck = {
  configured: boolean;
  checkedAt: string;
  status: {
    current: string;
    latest: string | null;
    newer: string[];
    updateAvailable: boolean;
    ahead: boolean;
  } | null;
  candidateDigest: string | null;
  candidateTag: string | null;
  preflights: Preflight[];
  applyable: boolean;
  error: string | null;
};

// A flat key, NOT useOrgQueryKey: useOrgSlug() returns null on /admin routes, so
// an org-prefixed key would namespace under `null`. There is no cross-tenant
// bleed to guard against on an instance-wide surface. Matches admin/allowlist.
const QUERY_KEY = ["admin", "updates"] as const;

const STATUS_ICON: Record<PreflightStatus, typeof CheckCircle2> = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
  unknown: HelpCircle,
};

const STATUS_CLASS: Record<PreflightStatus, string> = {
  pass: "text-green-600 dark:text-green-500",
  warn: "text-amber-600 dark:text-amber-500",
  fail: "text-red-600 dark:text-red-500",
  unknown: "text-muted-foreground",
};

function PreflightRow({ check }: { check: Preflight }) {
  const Icon = STATUS_ICON[check.status];
  return (
    <li className="flex gap-3 py-2">
      <Icon className={cn("mt-0.5 size-4 shrink-0", STATUS_CLASS[check.status])} aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {check.title}
          {check.blocking && check.status !== "pass" && (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              blocks upgrade
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">{check.detail}</p>
      </div>
    </li>
  );
}

export function UpdatesManager() {
  const { data, isFetching, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => jsonFetch<UpdateCheck>("/api/v1/admin/updates"),
    // A registry round-trip is not free and the answer changes on release
    // cadence, not on focus. Refetch is an explicit operator action.
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  if (!data) return null;

  const { status } = data;

  return (
    <div className="space-y-4">
      <SectionCard
        icon={Package}
        title="Application version"
        description="This instance, compared against the container registry it is configured for."
      >
        {!data.configured ? (
          <p className="text-sm text-muted-foreground">
            Update checking is not configured. Set <code className="rounded bg-muted px-1">COSMOS_UPDATE_IMAGE_REPO</code>{" "}
            to the repository this deployment pulls from to enable it.
          </p>
        ) : data.error ? (
          // An unreadable registry is explicitly NOT "you are up to date". Saying
          // so is the whole point — the opposite claim is the bug this feature
          // was written after.
          <div className="space-y-1">
            <p className="text-sm font-medium text-amber-600 dark:text-amber-500">
              Could not reach the registry — update status is unknown.
            </p>
            <p className="text-xs text-muted-foreground">{data.error}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Running</dt>
              <dd className="font-mono">{status?.current}</dd>
              <dt className="text-muted-foreground">Newest available</dt>
              <dd className="font-mono">{status?.latest ?? "—"}</dd>
              {data.candidateTag && (
                <>
                  <dt className="text-muted-foreground">Candidate tag</dt>
                  <dd className="font-mono">{data.candidateTag}</dd>
                </>
              )}
              {data.candidateDigest && (
                <>
                  <dt className="text-muted-foreground">Digest</dt>
                  <dd className="truncate font-mono text-xs">{data.candidateDigest}</dd>
                </>
              )}
            </dl>

            {status?.ahead ? (
              <p className="text-sm text-amber-600 dark:text-amber-500">
                This instance is newer than anything the registry offers. No update is available, and the
                newest tag would be a downgrade.
              </p>
            ) : status?.updateAvailable ? (
              <p className="text-sm">
                <span className="font-medium">{status.newer.length}</span>{" "}
                {status.newer.length === 1 ? "release" : "releases"} available.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">This instance is up to date.</p>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn("mr-2 size-4", isFetching && "animate-spin")} aria-hidden />
            {isFetching ? "Checking…" : "Check for updates"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Last checked {new Date(data.checkedAt).toLocaleString()}
          </span>
        </div>
      </SectionCard>

      {data.preflights.length > 0 && (
        <SectionCard
          icon={AlertTriangle}
          title="Preflight checks"
          description="Run before an upgrade is offered, so a one-click apply is never unconditional."
        >
          <ul className="divide-y">
            {data.preflights.map((p) => (
              <PreflightRow key={p.id} check={p} />
            ))}
          </ul>
          <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
            {data.applyable
              ? "All blocking checks passed."
              : "Applying an upgrade is not offered from this screen. Cosmos runs inside the image being replaced, so it cannot upgrade itself — and some checks (disk headroom for the image and the pre-upgrade database dump) are not observable from inside the container. The host-side deploy runner performs those and applies the upgrade."}
          </p>
        </SectionCard>
      )}
    </div>
  );
}
