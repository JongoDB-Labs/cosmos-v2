"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import type { AutomationConfig } from "@/lib/feedback/automation-config";
import { ORG_ROLES } from "@/lib/feedback/role-gating";
import { HIGH_RISK_ZONES } from "@/lib/feedback/guardrails";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldCheck, Info } from "lucide-react";
import type { OrgRole } from "@prisma/client";

/** Client mirror of `IntakePolicy` (kept local so this client bundle never
 *  imports the server-only intake-policy module, which pulls in the AI egress
 *  path via the security-judge). The API is the source of truth for defaults. */
type JudgeConfidence = "low" | "medium" | "high";

interface IntakeLimits {
  perUserPerRun: number;
  perOrgPerRun: number;
  maxQueueDepth: number;
  buildBudget: number;
}

interface IntakePolicy {
  rateLimits: IntakeLimits;
  autoTriggerRoles: OrgRole[];
  classifier: { judgeMinConfidence: JudgeConfidence };
  highRiskZones: string[];
}

interface ConfigResponse extends AutomationConfig {
  intakePolicy: IntakePolicy;
}

const ROLE_LABEL: Record<OrgRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  BILLING_ADMIN: "Billing admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
  GUEST: "Guest",
};

const CONFIDENCE_HELP: Record<JudgeConfidence, string> = {
  low: "Strictest — even a weak AI flag routes the item to a human.",
  medium: "Balanced (default) — a medium-or-higher flag routes to a human.",
  high: "Most permissive — only a firm, high-confidence flag routes to a human.",
};

const LIMIT_FIELDS: { key: keyof IntakeLimits; label: string; help: string }[] = [
  { key: "perUserPerRun", label: "Per submitter / run", help: "Max items one person can send to build per run." },
  { key: "perOrgPerRun", label: "Per org / run", help: "Max items the whole org can send to build per run." },
  { key: "maxQueueDepth", label: "Max queue depth", help: "Ceiling on the total in-flight build queue." },
  { key: "buildBudget", label: "Build budget", help: "Per-run cost budget (a feature costs more than a bug)." },
];

/**
 * Edit the org's feedback INTAKE POLICY (COSMOS-121, Phase 3c): the security-judge
 * confidence threshold, which submitter roles may auto-trigger a build, the active
 * high-risk touch zones, and the intake rate limits. Every field has a safe
 * default (served by the config endpoint); a save takes effect on the next
 * remediation run. Round-trips the two automation blocks unchanged so this card
 * never clobbers the auto-triage / delivery settings above it.
 */
export function IntakePolicyForm({ orgId }: { orgId: string }) {
  const cfgKey = useOrgQueryKey("feedback-remediation-config");
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: cfgKey,
    queryFn: () => jsonFetch<ConfigResponse>(`/api/v1/orgs/${orgId}/feedback/remediation-config`),
  });

  const [confidence, setConfidence] = useState<JudgeConfidence>("medium");
  const [roles, setRoles] = useState<Set<OrgRole>>(new Set());
  const [zones, setZones] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<IntakeLimits>({
    perUserPerRun: 10,
    perOrgPerRun: 50,
    maxQueueDepth: 100,
    buildBudget: 100,
  });
  const [saving, setSaving] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (data?.intakePolicy) {
      setConfidence(data.intakePolicy.classifier.judgeMinConfidence);
      setRoles(new Set(data.intakePolicy.autoTriggerRoles));
      setZones(new Set(data.intakePolicy.highRiskZones));
      setLimits(data.intakePolicy.rateLimits);
    }
  }, [data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function toggle<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  async function save() {
    if (!data) return;
    const policy: IntakePolicy = {
      rateLimits: limits,
      autoTriggerRoles: ORG_ROLES.filter((r) => roles.has(r)),
      classifier: { judgeMinConfidence: confidence },
      highRiskZones: HIGH_RISK_ZONES.map((z) => z.key).filter((k) => zones.has(k)),
    };
    setSaving(true);
    try {
      const saved = await jsonFetch<ConfigResponse>(`/api/v1/orgs/${orgId}/feedback/remediation-config`, {
        method: "PUT",
        body: JSON.stringify({
          // Round-trip the automation blocks untouched — the PUT requires them.
          autoRemediation: data.autoRemediation,
          autonomousDelivery: data.autonomousDelivery,
          intakePolicy: policy,
        }),
      });
      // Write the normalized policy the server echoed back into the shared cache
      // so this card (and the automation form) re-seed from the saved state.
      qc.setQueryData<ConfigResponse>(cfgKey, (old) =>
        old ? { ...old, intakePolicy: saved.intakePolicy } : old,
      );
      toast.success("Intake policy saved");
    } catch (err) {
      notifyError(err, "Couldn't save the intake policy.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-2xl">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-center gap-2 font-medium text-[var(--text)]">
        <ShieldCheck className="size-4 text-[var(--primary)]" /> Intake policy
      </div>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Guardrails applied to every feature request and bug report before it can become an
        autonomous build. Safe defaults are in effect until you change them; edits take effect on
        the next run.
      </p>

      {/* Classifier sensitivity */}
      <div className="mt-5">
        <Label className="text-xs font-medium text-[var(--text-muted)]">Classifier sensitivity</Label>
        <Select value={confidence} onValueChange={(v) => v && setConfidence(v as JudgeConfidence)}>
          <SelectTrigger size="sm" className="mt-1 w-full max-w-sm text-sm" aria-label="Classifier sensitivity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Strict</SelectItem>
            <SelectItem value="medium">Balanced (default)</SelectItem>
            <SelectItem value="high">Permissive</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{CONFIDENCE_HELP[confidence]}</p>
      </div>

      {/* Auto-trigger roles */}
      <div className="mt-5">
        <Label className="text-xs font-medium text-[var(--text-muted)]">Roles that may auto-trigger a build</Label>
        <div
          role="group"
          aria-label="Roles that may auto-trigger a build"
          className="mt-1 divide-y divide-[var(--border)] rounded-md border border-[var(--border)]"
        >
          {ORG_ROLES.map((r) => (
            <label key={r} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--muted)]/30">
              <Checkbox checked={roles.has(r)} onChange={() => setRoles((s) => toggle(s, r))} />
              <span>{ROLE_LABEL[r]}</span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Submitters in unchecked roles are routed to human triage instead of an automatic build.
        </p>
      </div>

      {/* High-risk zones */}
      <div className="mt-5">
        <Label className="text-xs font-medium text-[var(--text-muted)]">High-risk touch zones</Label>
        <div
          role="group"
          aria-label="High-risk touch zones"
          className="mt-1 divide-y divide-[var(--border)] rounded-md border border-[var(--border)]"
        >
          {HIGH_RISK_ZONES.map((z) => (
            <label key={z.key} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--muted)]/30">
              <Checkbox checked={zones.has(z.key)} onChange={() => setZones((s) => toggle(s, z.key))} />
              <span>{z.label}</span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          A feedback item touching a checked zone is parked for a human at intake. Security-critical
          checks (prompt-injection, sabotage, pasted secrets, content-safety) always run and can&apos;t be
          turned off.
        </p>
      </div>

      {/* Rate limits */}
      <div className="mt-5">
        <Label className="text-xs font-medium text-[var(--text-muted)]">Rate limits</Label>
        <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {LIMIT_FIELDS.map((f) => (
            <div key={f.key}>
              <Label htmlFor={`limit-${f.key}`} className="text-xs text-[var(--text)]">
                {f.label}
              </Label>
              <Input
                id={`limit-${f.key}`}
                type="number"
                min={0}
                value={limits[f.key]}
                onChange={(e) =>
                  setLimits((l) => ({ ...l, [f.key]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))
                }
                className="mt-1 h-8 text-sm"
              />
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{f.help}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5 flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--muted)]/30 p-3 text-xs text-[var(--text-muted)]">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>Higher caps admit more items per run; a value of 0 blocks that path entirely.</p>
      </div>

      <div className="mt-4">
        <Button onClick={save} disabled={saving} size="sm">
          {saving ? "Saving…" : "Save policy"}
        </Button>
      </div>
    </div>
  );
}
