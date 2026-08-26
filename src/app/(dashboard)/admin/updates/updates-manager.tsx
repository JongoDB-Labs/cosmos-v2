"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package, CheckCircle2, AlertTriangle, XCircle, HelpCircle, RefreshCw, FileText, Rocket, History, Puzzle } from "lucide-react";
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
  /** Set when another tier owns this check — see src/lib/updates/preflight.ts. */
  deferredTo?: "host-runner";
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
const DEPLOY_KEY = ["admin", "updates", "deploy"] as const;

type DeployStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "ABANDONED";

type DeployRequest = {
  id: string;
  version: string;
  status: DeployStatus;
  requestedAt: string;
  requestedByEmail: string;
  claimedAt: string | null;
  claimedBy: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  log: string;
  /** How long this has sat unclaimed, computed server-side (see the route). */
  unclaimedMs: number;
};

/** Terminal states — nothing further will change on its own. */
const DONE: DeployStatus[] = ["SUCCEEDED", "FAILED", "ABANDONED"];

/**
 * A request nobody has claimed after this long almost certainly means no host
 * runner is installed or running. Saying "queued" forever would be the exact
 * lie this surface exists to avoid, so past this point the panel says so.
 */
const UNCLAIMED_WARN_MS = 60_000;

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
          {/* A deferred check is not blocking HERE and must not be labelled as
              though it were — it is answered on the host, immediately before
              the deploy starts. Saying "blocks upgrade" for something that
              never can be answered on this side is how a page trains its
              operator to ignore the badge. */}
          {check.deferredTo ? (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              checked on the host
            </span>
          ) : (
            check.blocking &&
            check.status !== "pass" && (
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                blocks upgrade
              </span>
            )
          )}
        </p>
        <p className="text-xs text-muted-foreground">{check.detail}</p>
      </div>
    </li>
  );
}

/**
 * The last deploy request, shared by the install control and the outcome card.
 *
 * ONE definition, two consumers. These cards render under different conditions —
 * the install control only when an upgrade is offered, the outcome whenever a
 * record exists — so they are mounted and unmounted independently. Two copies of
 * this query would drift in exactly the way that lets one of them stop polling a
 * deploy the other is still showing as running.
 */
function useDeployStatus() {
  return useQuery({
    queryKey: DEPLOY_KEY,
    queryFn: () => jsonFetch<{ latest: DeployRequest | null }>("/api/v1/admin/updates/deploy"),
    // Poll only while something is actually in flight; a finished deploy does
    // not change again, and an idle admin page should not talk to the server
    // every second forever.
    refetchInterval: (q) => {
      const s = q.state.data?.latest?.status;
      return s && !DONE.includes(s) ? 2000 : false;
    },
    refetchOnWindowFocus: false,
  });
}

function DeployPanel({ version, applyable }: { version: string; applyable: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data } = useDeployStatus();

  const latest = data?.latest ?? null;
  const active = latest && !DONE.includes(latest.status) ? latest : null;

  const start = useMutation({
    mutationFn: () =>
      jsonFetch<DeployRequest>("/api/v1/admin/updates/deploy", {
        method: "POST",
        body: JSON.stringify({ version }),
      }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: DEPLOY_KEY });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "The request was refused."),
  });

  return (
    <SectionCard
      icon={Rocket}
      title="Install this version"
      description="Runs the same deploy the operator would run by hand, on the server."
    >
      {active ? (
        <div className="space-y-2">
          <p className="text-sm">
            <span className="font-medium">{active.version}</span> —{" "}
            {active.status === "PENDING" ? "queued" : "installing"}
            {active.claimedBy && <span className="text-muted-foreground"> on {active.claimedBy}</span>}
          </p>
          {active.status === "PENDING" && active.unclaimedMs > UNCLAIMED_WARN_MS && (
            // Never imply progress that is not happening.
            <p className="text-sm text-amber-600 dark:text-amber-500">
              Nothing has picked this up. The server-side deploy runner may not be installed or running —
              this request will stay queued until it is.
            </p>
          )}
        </div>
      ) : (
        <>
          <Button onClick={() => start.mutate()} disabled={!applyable || start.isPending}>
            <Rocket className="mr-2 size-4" aria-hidden />
            {start.isPending ? "Requesting…" : `Install ${version}`}
          </Button>
          {!applyable && (
            <p className="mt-2 text-xs text-muted-foreground">
              Unavailable until every blocking check above passes.
            </p>
          )}
        </>
      )}

      {error && <p className="mt-3 text-sm text-amber-600 dark:text-amber-500">{error}</p>}
    </SectionCard>
  );
}

/**
 * What the last install did — rendered whenever a record exists, NOT only while
 * an upgrade is on offer.
 *
 * WHY THIS IS ITS OWN CARD. This lived inside the install panel, which renders
 * only when `updateAvailable`. A SUCCESSFUL install makes that false — you are
 * now on the newest version — so the panel unmounted the moment it worked and
 * took the outcome and the log with it. The asymmetry was the tell: a FAILED
 * install left the version unchanged, kept the upgrade on offer, and stayed
 * visible. The one outcome an operator most needs confirmed was the only one
 * the screen erased, leaving them to infer success from the version number.
 *
 * The deploy also restarts the app underneath the page, so the reload that
 * follows is exactly when this has to survive.
 */
function LastDeployCard() {
  const { data } = useDeployStatus();
  const latest = data?.latest ?? null;
  if (!latest) return null;

  const succeeded = latest.status === "SUCCEEDED";
  return (
    <SectionCard
      icon={succeeded ? CheckCircle2 : History}
      title="Last install"
      description="The most recent install started from this page, and what the server reported."
    >
      <p className="text-sm">
        <span className="font-mono">{latest.version}</span> — {latest.status.toLowerCase()}
        {latest.exitCode !== null && !succeeded && ` (exit ${latest.exitCode})`}
        <span className="text-muted-foreground">
          {" · requested by "}
          {latest.requestedByEmail}
          {latest.claimedBy && ` · ran on ${latest.claimedBy}`}
        </span>
      </p>
      {latest.status === "ABANDONED" && (
        // ABANDONED is UNKNOWN. Presenting it as a failure would read as
        // "nothing happened", which may be false.
        <p className="mt-1 text-sm text-amber-600 dark:text-amber-500">
          The runner stopped reporting, so the outcome of this install is unknown — it may have
          completed, partly run, or never started. Check the running version above before starting
          another.
        </p>
      )}
      {latest.log && (
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs leading-relaxed">
          {latest.log}
        </pre>
      )}
    </SectionCard>
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

      {status?.updateAvailable && status.latest && (
        <DeployPanel version={status.latest} applyable={data.applyable} />
      )}

      {/* Deliberately NOT gated on `updateAvailable` — see LastDeployCard. */}
      <LastDeployCard />

      <PluginVersionsCard />

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

type PluginOrg = {
  orgId: string;
  orgName: string;
  enabledVersion: string | null;
  upToDate: boolean;
};

type PluginStatus = {
  slug: string;
  name: string;
  deployedVersion: string | null;
  behind: PluginOrg[];
  current: PluginOrg[];
};

/**
 * Plugin versions, and applying an upgrade that has not happened on its own.
 *
 * A plugin's CODE is never out of date — it was composed into this image. What
 * lags is the per-org record of which version last ran its upgrade hook, and
 * core compares that record to decide whether to run it again. It lags for an
 * ordinary reason: reconciliation happens when somebody opens the plugin, so an
 * org that has not opened it since the release has not reconciled, and one that
 * never opens it never will.
 *
 * That is harmless for an idempotent seed and not harmless for anything that has
 * to happen once, which is why this offers a button rather than an explanation.
 */
function PluginVersionsCard() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["admin", "updates", "plugins"],
    queryFn: () => jsonFetch<{ plugins: PluginStatus[] }>("/api/v1/admin/updates/plugins"),
  });

  const apply = useMutation({
    mutationFn: (slug: string) =>
      jsonFetch<{ reconciled: number; failed: { orgName: string }[] }>(
        "/api/v1/admin/updates/plugins",
        { method: "POST", body: JSON.stringify({ slug }) },
      ),
    onSettled: () => {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ["admin", "updates", "plugins"] });
    },
  });

  const plugins = q.data?.plugins ?? [];
  if (q.isLoading || plugins.length === 0) return null;

  const anyBehind = plugins.some((p) => p.behind.length > 0);

  return (
    <SectionCard
      icon={Puzzle}
      title="Plugins"
      description={
        anyBehind
          ? "Installed with this image. Some organisations have not run the new version's upgrade step yet."
          : "Installed with this image, and every organisation is on the current version."
      }
    >
      <ul className="divide-y">
        {plugins.map((p) => (
          <li key={p.slug} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-40 flex-1">
              <span className="font-medium">{p.name}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {p.deployedVersion ?? "no version declared"}
              </span>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {p.behind.length === 0
                  ? `${p.current.length} organisation${p.current.length === 1 ? "" : "s"} up to date`
                  : `${p.behind.length} behind: ${p.behind
                      .map((o) => `${o.orgName} (${o.enabledVersion ?? "never run"})`)
                      .join(", ")}`}
              </p>
            </div>
            {p.behind.length === 0 ? (
              <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Current
              </span>
            ) : (
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  setBusy(p.slug);
                  apply.mutate(p.slug);
                }}
              >
                {busy === p.slug ? "Applying…" : "Apply upgrade"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
        This does not change the image. It runs each plugin&rsquo;s own upgrade step for the
        organisations that have not reached it yet &mdash; the same step that would run by itself
        the next time somebody opened that plugin.
      </p>
    </SectionCard>
  );
}
