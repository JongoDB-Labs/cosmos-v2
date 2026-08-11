"use client";

import { useQuery } from "@tanstack/react-query";
import { Package, CheckCircle2, AlertTriangle, XCircle, HelpCircle, RefreshCw, FileText } from "lucide-react";
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

type NoteHighlight = { kind: "feature" | "improvement" | "fix"; text: string };

type ReleaseNote = {
  version: string;
  date: string | null;
  title: string | null;
  highlights: NoteHighlight[];
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
  notes: ReleaseNote[];
  notesOmitted: number;
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

const KIND_LABEL: Record<NoteHighlight["kind"], string> = {
  feature: "New",
  improvement: "Improved",
  fix: "Fixed",
};

function ReleaseNoteBlock({ note }: { note: ReleaseNote }) {
  return (
    <div className="border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-sm font-medium">{note.version}</span>
        {note.date && <span className="text-xs text-muted-foreground">{note.date}</span>}
      </div>
      {note.title && <p className="mt-0.5 text-sm">{note.title}</p>}
      <ul className="mt-2 space-y-1.5">
        {note.highlights.map((h, i) => (
          <li key={i} className="flex gap-2 text-xs">
            <span className="mt-px shrink-0 rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
              {KIND_LABEL[h.kind]}
            </span>
            <span className="text-muted-foreground">{h.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const { data, isPending, isError, error, isFetching, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => jsonFetch<UpdateCheck>("/api/v1/admin/updates"),
    // A registry round-trip is not free and the answer changes on release
    // cadence, not on focus. Refetch is an explicit operator action.
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  // WHY THESE TWO STATES EXIST AT ALL: this shipped as `if (!data) return null`,
  // which renders NOTHING while the registry call is in flight and NOTHING
  // forever if it fails. On the first production deploy the page showed its
  // heading and an empty space, and a blank panel gives an operator — and the
  // person debugging it — no way to tell "still working" from "failed" from
  // "never ran". A surface whose whole purpose is to distinguish *unknown* from
  // *up to date* must not have an unknown state of its own that looks like
  // nothing at all.
  if (isPending) {
    return (
      <SectionCard
        icon={Package}
        title="Application version"
        description="This instance, compared against the container registry it is configured for."
      >
        <p className="text-sm text-muted-foreground">Checking for updates…</p>
      </SectionCard>
    );
  }

  if (isError) {
    return (
      <SectionCard
        icon={AlertTriangle}
        title="Application version"
        description="This instance, compared against the container registry it is configured for."
      >
        <p className="text-sm font-medium text-amber-600 dark:text-amber-500">
          Could not check for updates.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {error instanceof Error ? error.message : "The request failed."}
        </p>
        <Button variant="outline" className="mt-4" onClick={() => void refetch()}>
          <RefreshCw className="mr-2 size-4" aria-hidden /> Try again
        </Button>
      </SectionCard>
    );
  }

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

      {status?.updateAvailable && (
        <SectionCard
          icon={FileText}
          title="What is in this update"
          description="Published alongside each release, read without downloading the image."
        >
          {data.notes.length > 0 ? (
            <>
              <div className="space-y-3">
                {data.notes.map((n) => (
                  <ReleaseNoteBlock key={n.version} note={n} />
                ))}
              </div>
              {data.notesOmitted > 0 && (
                // Never imply the list is complete when it is not.
                <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                  {data.notesOmitted} older {data.notesOmitted === 1 ? "release is" : "releases are"} not shown.
                </p>
              )}
            </>
          ) : (
            // Distinct from "no changes": nothing was published, which is not
            // the same as nothing having changed.
            <p className="text-sm text-muted-foreground">
              No release notes are published for{" "}
              {status.newer.length === 1 ? "this release" : "these releases"} in this registry.
            </p>
          )}
        </SectionCard>
      )}

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
