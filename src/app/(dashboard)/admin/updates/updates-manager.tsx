"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileText, HelpCircle, History, Package, Puzzle, RefreshCw, Rocket, Server, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LocalTimestamp } from "@/components/ui/local-timestamp";
import { SectionCard } from "@/components/ui/section-card";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { cn } from "@/lib/utils";
// Type-only: the module talks to the database, and a value import would pull it
// into the client bundle.
import type { ReconcileStatusDto } from "@/lib/updates/reconcile-status";
import type { JobsReport } from "@/lib/jobs/report";

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
  /** The image for the RUNNING version was rebuilt; null when the instance does not know its own digest. */
  rebuildAvailable: boolean | null;
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

function DeployPanel({
  version,
  applyable,
  reinstall = false,
}: {
  version: string;
  applyable: boolean;
  /** The running version, rebuilt: same request, same runner, different words. */
  reinstall?: boolean;
}) {
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
      title={reinstall ? "Reinstall this version" : "Install this version"}
      description={
        reinstall
          ? "Pulls the rebuilt image and runs the same deploy as an upgrade, on the server — backup, migration and health check included."
          : "Runs the same deploy the operator would run by hand, on the server."
      }
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
            {start.isPending ? "Requesting…" : `${reinstall ? "Reinstall" : "Install"} ${version}`}
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


const SETTINGS_KEY = ["admin", "update-settings"] as const;

type HealthTone = "ok" | "warn" | "error" | "muted";

type ValueSource = "settings" | "env" | "default" | "unset";

type RegistryField = { value: string | null; source: ValueSource; envValue: string | null };

/** Mirrors GET /api/v1/admin/updates/settings. The password itself never
 *  arrives — only whether one is set, and from where. */
type UpdateSettingsPayload = {
  autoUpdate: boolean;
  updatedAt: string | null;
  reconcile?: ReconcileStatusDto | null;
  reconcileHealth?: { tone: HealthTone; headline: string; detail: string | null };
  /** Whether the outbox worker (webhooks, automations) is keeping up. */
  eventBacklog?: { tone: HealthTone; headline: string; detail: string | null };
  /** The background jobs on the instance that answered. */
  jobs?: JobsReport;
  registry?: {
    imageRepo: RegistryField;
    tagSuffix: RegistryField;
    username: RegistryField;
    password: { set: boolean; source: ValueSource; envSet: boolean };
  };
};

/** One query for the switch, the installer's report and the registry, shared by
 *  the cards below so they can never show two different reads of the row. */
function useUpdateSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => jsonFetch<UpdateSettingsPayload>("/api/v1/admin/updates/settings"),
    refetchOnWindowFocus: false,
    // The installer reports every few minutes; re-read so "gone quiet" shows up
    // on a page left open, without anyone pressing anything.
    refetchInterval: 60_000,
  });
}

const HEALTH_ICON: Record<HealthTone, typeof CheckCircle2> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
  muted: HelpCircle,
};

const HEALTH_CLASS: Record<HealthTone, string> = {
  ok: "text-green-600 dark:text-green-500",
  warn: "text-amber-600 dark:text-amber-500",
  error: "text-red-600 dark:text-red-500",
  muted: "text-muted-foreground",
};

/**
 * What the automatic installer last said it did. The switch above it is only a
 * request; this line is whether anything is acting on it. Without it, the page
 * said "Automatic" over an installer that had stopped, and the only record was
 * a log file on the host.
 */
function InstallerHealth({ data }: { data: UpdateSettingsPayload }) {
  const health = data.reconcileHealth;
  if (!health) return null;
  const Icon = HEALTH_ICON[health.tone];
  return (
    <div className="mt-4 flex gap-3 border-t pt-3" data-testid="installer-health" data-tone={health.tone}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", HEALTH_CLASS[health.tone])} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className={cn("text-sm font-medium", HEALTH_CLASS[health.tone])}>{health.headline}</p>
        {health.detail && <p className="text-xs text-muted-foreground">{health.detail}</p>}
        {data.reconcile && (
          <p className="text-xs text-muted-foreground">
            Last checked <LocalTimestamp value={data.reconcile.checkedAt} />
            {data.reconcile.source && <> · looking in {data.reconcile.source}</>}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Whether the background worker that sends webhooks and runs automations is
 * keeping up with changes. On a deployment whose logs nobody can read, a stopped
 * worker would otherwise show nowhere: webhooks and rules would just go quiet.
 */
function EventWorkerHealth({ data }: { data: UpdateSettingsPayload }) {
  const health = data.eventBacklog;
  if (!health) return null;
  const Icon = HEALTH_ICON[health.tone];
  return (
    <div className="mt-3 flex gap-3 border-t pt-3" data-testid="event-worker-health" data-tone={health.tone}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", HEALTH_CLASS[health.tone])} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className={cn("text-sm font-medium", HEALTH_CLASS[health.tone])}>{health.headline}</p>
        {health.detail && <p className="text-xs text-muted-foreground">{health.detail}</p>}
      </div>
    </div>
  );
}

const ago = (seconds: number) =>
  seconds < 90 ? `${seconds} s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`;

/**
 * Each background job on the instance that answered: whether the runner is on
 * here (and why not), whether this instance leads the job, its last run and
 * success, and its last failure. A job stuck past its timeout, or failing, is
 * the line to read when the event worker looks stopped.
 */
function JobsHealth({ data }: { data: UpdateSettingsPayload }) {
  const jobs = data.jobs;
  if (!jobs) return null;
  const bad = jobs.jobs.filter((j) => j.stuck || j.consecutiveFailures > 0);
  const tone: HealthTone = !jobs.enabled || bad.length ? "error" : "ok";
  const Icon = HEALTH_ICON[tone];
  const leading = jobs.jobs.filter((j) => j.leader).length;
  const headline = !jobs.enabled
    ? `Background jobs are off on this instance: ${jobs.reason}.`
    : bad.length
      ? `${bad.length} background ${bad.length === 1 ? "job is" : "jobs are"} stuck or failing.`
      : `Background jobs are running: this instance leads ${leading} of ${jobs.jobs.length}.`;
  return (
    <div className="mt-3 border-t pt-3" data-testid="jobs-health" data-tone={tone}>
      <div className="flex gap-3">
        <Icon className={cn("mt-0.5 size-4 shrink-0", HEALTH_CLASS[tone])} aria-hidden />
        <p className={cn("text-sm font-medium", HEALTH_CLASS[tone])}>{headline}</p>
      </div>
      {jobs.jobs.length > 0 && (
        <table className="mt-2 w-full text-xs" aria-label="Background jobs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-2 font-normal">Job</th>
              <th className="py-1 pr-2 font-normal">Here</th>
              <th className="py-1 pr-2 font-normal">Last run</th>
              <th className="py-1 pr-2 font-normal">Last success</th>
              <th className="py-1 font-normal">State</th>
            </tr>
          </thead>
          <tbody>
            {jobs.jobs.map((j) => (
              <tr key={j.name} className="border-t align-top">
                <td className="py-1 pr-2 font-mono">{j.name}</td>
                <td className="py-1 pr-2">{j.leader ? "leads" : "standby"}</td>
                <td className="py-1 pr-2">
                  <LocalTimestamp value={j.lastStartedAt} />
                </td>
                <td className="py-1 pr-2">
                  <LocalTimestamp value={j.lastSucceededAt} />
                </td>
                <td className={cn("py-1", (j.stuck || j.consecutiveFailures > 0) && HEALTH_CLASS.error)}>
                  {j.stuck
                    ? `Stuck: running for ${ago(j.runningForSeconds ?? 0)}`
                    : j.consecutiveFailures > 0
                      ? `Failing (${j.consecutiveFailures}×): ${[j.lastErrorClass, j.lastErrorMessage].filter(Boolean).join(": ")}`
                      : j.running
                        ? "Running"
                        : "OK"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Does this instance install a newer version by itself?
 *
 * Deliberately NOT gated on `updateAvailable`, for the same reason as
 * LastDeployCard: the answer to "will this update itself?" is exactly what an
 * operator wants when nothing is pending, and a control that appears only during
 * an upgrade is one you cannot find when you need to set it.
 *
 * The switch stores a preference and nothing else. The host-side daemon reads it
 * on its next pass — the web tier has no path to the host, and this must not
 * become one.
 */
function UpdateModeCard() {
  const qc = useQueryClient();
  const { data, isPending, isError } = useUpdateSettings();
  const save = useMutation({
    mutationFn: (autoUpdate: boolean) =>
      jsonFetch("/api/v1/admin/updates/settings", {
        method: "PUT",
        body: JSON.stringify({ autoUpdate }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });

  return (
    <SectionCard
      icon={RefreshCw}
      title="How updates are installed"
      description="Whether this instance installs a newer version on its own, or waits for you."
    >
      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : isError ? (
        // Never imply a setting we could not read. "Automatic" shown over a
        // failed fetch is the kind of confident wrong answer this page exists
        // to avoid.
        <p className="text-sm text-muted-foreground">
          Could not read the current setting. Reload to try again.
        </p>
      ) : (
        <>
          <div className="flex gap-2">
            {([true, false] as const).map((mode) => (
              <Button
                key={String(mode)}
                size="sm"
                variant={data.autoUpdate === mode ? "default" : "outline"}
                aria-pressed={data.autoUpdate === mode}
                disabled={save.isPending}
                onClick={() => save.mutate(mode)}
              >
                {mode ? "Automatic" : "Manual"}
              </Button>
            ))}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {data.autoUpdate
              ? "A newer version installs itself once its image is built. The install is recorded below, and can be rolled back."
              : "A newer version is reported here and in the delivery activity feed, and waits for you to press Install."}
          </p>
          {save.isError && (
            <p className="mt-2 text-sm text-destructive">
              Could not save that. The setting is unchanged.
            </p>
          )}
          <InstallerHealth data={data} />
          <EventWorkerHealth data={data} />
          <JobsHealth data={data} />
        </>
      )}
    </SectionCard>
  );
}

const SOURCE_LABEL: Record<ValueSource, string> = {
  settings: "Set here",
  env: "From environment",
  default: "Derived from the repository",
  unset: "Not set",
};

type RegistryDraft = { imageRepo?: string; tagSuffix?: string; username?: string; password?: string };
type RegistryPut = RegistryDraft & { clearPassword?: boolean };

/**
 * Where this page and the automatic installer look for new versions.
 *
 * Every field says where its value came from, because the failure this exists
 * for is the app and the installer reading DIFFERENT registries after a move,
 * with nothing on screen saying which either was using. A saved value overrides
 * the environment; "Use environment value" drops the override.
 *
 * The password is write-only: the server never sends it, so the field is always
 * empty and only says whether one is saved.
 */
function RegistryCard() {
  const qc = useQueryClient();
  const { data } = useUpdateSettings();
  const [draft, setDraft] = useState<RegistryDraft>({});
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: RegistryPut) =>
      jsonFetch("/api/v1/admin/updates/settings", {
        method: "PUT",
        body: JSON.stringify({ registry: body }),
      }),
    onSuccess: () => {
      setError(null);
      setDraft({});
      void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      // The version check reads the registry these settings choose.
      void qc.invalidateQueries({ queryKey: QUERY_KEY, exact: true });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not save the registry settings."),
  });

  const reg = data?.registry;
  if (!reg) return null;

  const dirty = Object.values(draft).some((v) => v !== undefined);

  const fields: { key: "imageRepo" | "tagSuffix" | "username"; label: string; hint: string }[] = [
    {
      key: "imageRepo",
      label: "Image repository",
      hint: "The registry host and path, without https:// or a tag — for example registry.example.com/cosmos/app.",
    },
    {
      key: "tagSuffix",
      label: "Tag suffix",
      hint: "For a composed instance whose tags end in -<suffix>. Usually the last part of the repository.",
    },
    { key: "username", label: "Username", hint: "Leave empty for a public registry." },
  ];

  return (
    <SectionCard
      icon={Server}
      title="Registry"
      description="Where this page and the automatic installer look for new versions."
    >
      <div className="space-y-4">
        {fields.map(({ key, label, hint }) => {
          const f = reg[key];
          const shown = draft[key] ?? (f.source === "settings" ? (f.value ?? "") : "");
          return (
            <div key={key} className="space-y-1">
              <FormField label={label} hint={hint}>
                {(p) => (
                  <Input
                    {...p}
                    value={shown}
                    placeholder={f.source === "settings" ? "" : (f.value ?? "")}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  />
                )}
              </FormField>
              <ProvenanceLine
                source={f.source}
                envDescription={f.envValue !== null ? `Environment: ${f.envValue === "" ? "(empty)" : f.envValue}` : "Environment: not set"}
                onUseEnv={() => save.mutate({ [key]: "" })}
                busy={save.isPending}
              />
            </div>
          );
        })}

        <div className="space-y-1">
          <FormField label="Password" hint="Write-only — a saved password is never shown again.">
            {(p) => (
              <Input
                {...p}
                type="password"
                value={draft.password ?? ""}
                placeholder={reg.password.set ? "••••••••" : ""}
                autoComplete="new-password"
                onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
              />
            )}
          </FormField>
          <ProvenanceLine
            source={reg.password.source}
            label={reg.password.source === "settings" ? "Saved" : undefined}
            envDescription={reg.password.envSet ? "Environment: set" : "Environment: not set"}
            onUseEnv={() => save.mutate({ clearPassword: true })}
            busy={save.isPending}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() => {
              // Untouched fields are left out, so Save never rewrites a value
              // the operator did not change. An emptied text field is sent as ""
              // (use the environment); an empty password means "keep it".
              const body: RegistryPut = {};
              for (const k of ["imageRepo", "tagSuffix", "username"] as const) {
                if (draft[k] !== undefined) body[k] = draft[k];
              }
              if (draft.password) body.password = draft.password;
              save.mutate(body);
            }}
          >
            {save.isPending ? "Checking the registry…" : "Save"}
          </Button>
          {dirty && !save.isPending && (
            <Button size="sm" variant="ghost" onClick={() => { setDraft({}); setError(null); }}>
              Discard changes
            </Button>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <p className="border-t pt-3 text-xs text-muted-foreground">
          Saving first lists the versions in the registry with these settings, and refuses anything that
          cannot. These settings change where new versions are looked for &mdash; on this page and by the
          automatic installer. They do not change where the host pulls images from: that stays pinned in
          the host&rsquo;s docker-compose.override.yml, so moving registries needs that file updated too.
          A repository on a different registry host than the environment&rsquo;s stops the environment&rsquo;s
          username, password, and migration, release-notes and plugin-service repositories on the old host
          from being used; on the same host they still apply. A tag suffix set in the environment always applies
          unless one is set here.
        </p>
      </div>
    </SectionCard>
  );
}

function ProvenanceLine({
  source,
  label,
  envDescription,
  onUseEnv,
  busy,
}: {
  source: ValueSource;
  label?: string;
  envDescription: string;
  onUseEnv: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="rounded bg-muted px-1.5 py-0.5 font-medium" data-testid="provenance">
        {label ?? SOURCE_LABEL[source]}
      </span>
      {source === "settings" && (
        <>
          <span>{envDescription}</span>
          <Button size="xs" variant="link" className="h-auto p-0 text-xs" disabled={busy} onClick={onUseEnv}>
            Use environment value
          </Button>
        </>
      )}
    </div>
  );
}

/** The cards that do not depend on the version check, rendered in every state
 *  of it — see the NOTE ON THE FRAGMENT in UpdatesManager. */
function SettingsCards() {
  return (
    <>
      <UpdateModeCard />
      <RegistryCard />
    </>
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
  // NOTE THE FRAGMENT. Both of these used to return the version card ALONE, so
  // while the registry call was in flight — or had failed — the update-mode
  // switch below simply did not exist. Observed on prod: the registry check hung
  // and the switch was unreachable, which is the same defect the card's own
  // comment warns about ("a control you can only find during an upgrade is one
  // you cannot find when you need it"), just reached by a different route. The
  // switch does not depend on the update check and must not be gated behind it.
  if (isPending) {
    return (
      <div className="space-y-4">
        <SettingsCards />
        <SectionCard
          icon={Package}
          title="Application version"
          description="This instance, compared against the container registry it is configured for."
        >
          <p className="text-sm text-muted-foreground">Checking for updates…</p>
        </SectionCard>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <SettingsCards />
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
      </div>
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
            to the repository this deployment pulls from, or enter it under Registry, to enable it.
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
            ) : data.rebuildAvailable ? (
              // Not "up to date": the version matches, the contents do not. On a
              // composed instance this is how a plugin-only release arrives.
              <p className="text-sm">
                The image for <span className="font-mono">{status?.current}</span> has been rebuilt since this
                instance installed it.
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

      {status?.updateAvailable && status.latest ? (
        <DeployPanel version={status.latest} applyable={data.applyable} />
      ) : (
        !status?.ahead &&
        data.rebuildAvailable &&
        status?.current && <DeployPanel version={status.current} applyable={data.applyable} reinstall />
      )}

      {/* Deliberately NOT gated on `updateAvailable` — see LastDeployCard. */}
      <SettingsCards />

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
