"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { TenantClass } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { SectionCard } from "@/components/ui/section-card";
import { notifyError } from "@/lib/errors/notify";
import {
  TENANT_CLASSES_BY_PROTECTIVENESS,
  isAtLeastAsProtective,
} from "@/lib/org/tenant-class";

interface OrgTenantClassProps {
  orgId: string;
  /** The org's CURRENT tenant class (source of truth = the server page). */
  current: TenantClass;
  /** Only the org OWNER may change it — and then only in the TIGHTEN direction. */
  isOwner: boolean;
}

/** Per-class copy. Ordered rendering + the tighten/loosen semantics come from
 *  @/lib/org/tenant-class so the UI and the API agree on one protectiveness ordering. */
const CLASS_BLURB: Record<TenantClass, string> = {
  GOV:
    "Most protective. Fully CUI-blind — project & ticket names, member names, notes, and other free-text tool-result content are masked before they reach the AI assistant. Commercial connector breadth and external MCP are disabled.",
  COMMERCIAL:
    "Least protective. CUI masking is off — the AI assistant sees this organization's content unmasked.",
};

const badgeVariant = (cls: TenantClass) => (cls === "GOV" ? "critical" : "strategic");

/**
 * Org-settings control for the tenant class that drives the CUI-blind egress gate.
 *
 * ASYMMETRIC by design (mirrors the tighten-only API at
 * /api/v1/orgs/[orgId]/tenant-class): an OWNER may TIGHTEN to a more-protective class
 * (that only INCREASES masking, so it is always safe). LOOSENING (removing masking) is shown
 * DISABLED with a platform-administrator-only note — it stays platform-owner-only, preserving
 * the AC-3 separation-of-duties control. Non-owners see the class read-only.
 */
export function OrgTenantClass({ orgId, current, isOwner }: OrgTenantClassProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<TenantClass>(current);
  const [saving, setSaving] = useState(false);

  // A real, applyable tighten is staged when the pick differs from current AND is at least as
  // protective (never a loosen — those radios are disabled, but guard here too, defense in depth).
  const staged = selected !== current && isAtLeastAsProtective(selected, current);

  async function applyChange() {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/tenant-class`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantClass: selected }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't update the tenant class.");
      }
      toast.success(`Tenant class increased to ${selected}.`);
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't update the tenant class.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      icon={ShieldCheck}
      title="Tenant class & CUI masking"
      description="Controls how much of this organization's content is masked (CUI-blind) before it reaches the AI assistant."
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--text-muted)]">Current:</span>
        <Badge variant={badgeVariant(current)}>{current}</Badge>
      </div>
      <p className="mt-2 text-xs text-[var(--text-muted)]">{CLASS_BLURB[current]}</p>

      {!isOwner ? (
        <p className="mt-4 text-xs text-[var(--text-muted)]">
          Only the organization owner can change the tenant class. Increasing protection
          (more masking) is self-service for the owner; reducing protection (removing CUI
          masking) always requires a platform administrator.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-sm font-medium">Change tenant class</p>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              You can tighten to a more protective class at any time — tightening increases CUI
              protection. Reducing protection (removing masking) is not self-service and requires
              a platform administrator.
            </p>
          </div>

          <fieldset className="space-y-2" aria-label="Tenant class">
            {TENANT_CLASSES_BY_PROTECTIVENESS.map((cls) => {
              const allowed = isAtLeastAsProtective(cls, current); // tighten or the current class
              return (
                <label
                  key={cls}
                  className={`flex gap-3 rounded-md border border-[var(--border)] p-3 ${
                    allowed ? "cursor-pointer" : "opacity-70"
                  }`}
                >
                  <input
                    type="radio"
                    name="tenant-class"
                    value={cls}
                    aria-label={cls}
                    checked={selected === cls}
                    disabled={!allowed || saving}
                    onChange={() => setSelected(cls)}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <Badge variant={badgeVariant(cls)}>{cls}</Badge>
                      {cls === current && (
                        <span className="text-[11px] text-[var(--text-muted)]">Current</span>
                      )}
                    </span>
                    <span className="mt-1 block text-xs text-[var(--text-muted)]">
                      {CLASS_BLURB[cls]}
                    </span>
                    {!allowed && (
                      <span className="mt-1 block text-[11px] font-medium text-[var(--status-warning-text,#b45309)]">
                        Platform administrator only — reducing masking requires a platform
                        administrator. Contact them to request this change.
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>

          {staged && (
            <div className="flex gap-2 rounded-md border border-[var(--status-critical)]/40 bg-[var(--status-critical)]/5 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-critical)]" />
              <p className="text-xs text-[var(--text)]">
                Increasing protection to <span className="font-semibold">{selected}</span> masks
                more of this organization&apos;s content from the AI assistant
                {selected === "GOV"
                  ? ", and disables commercial connector breadth and external MCP"
                  : ""}
                . This change is audited and{" "}
                <span className="font-semibold">cannot be undone by you</span> — only a platform
                administrator can later reduce protection.
              </p>
            </div>
          )}

          <ConfirmButton
            variant="default"
            confirmLabel={`Yes, increase protection to ${selected}`}
            pending={saving}
            disabled={!staged || saving}
            onConfirm={applyChange}
          >
            Increase protection
          </ConfirmButton>
        </div>
      )}
    </SectionCard>
  );
}
