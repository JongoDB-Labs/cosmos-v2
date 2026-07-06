"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/errors/notify";
import { SECTOR_FIELD_SECTORS, SECTOR_FIELD_TEMPLATES } from "@/lib/custom-fields/sector-field-templates";

const SECTOR_LABELS: Record<string, string> = {
  software: "Software",
  govcon: "GovCon / Defense",
  aec: "Construction (AEC)",
  consulting: "Consulting",
  education: "Education",
  event: "Events",
  manufacturing: "Manufacturing",
  ops: "Operations",
};

/**
 * Apply a sector's curated field set (FR 454637a9). New projects created from a
 * sector template seed automatically; this is the retrofit path for existing
 * orgs. Idempotent — fields you already have (by key) are never overwritten.
 */
export function SectorFieldSets({
  orgId,
  onApplied,
}: {
  orgId: string;
  /** Refresh the field list after an apply. */
  onApplied: () => void;
}) {
  const [applying, setApplying] = useState<string | null>(null);

  async function apply(sector: string) {
    setApplying(sector);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/custom-fields/apply-sector`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sector }),
      });
      if (!res.ok) throw new Error("Couldn't apply the field set.");
      const data = (await res.json()) as { created: number; skipped: string[] };
      if (data.created === 0) {
        toast.message("Already applied", {
          description: `All ${data.skipped.length} ${SECTOR_LABELS[sector] ?? sector} fields already exist.`,
        });
      } else {
        toast.success(
          `Added ${data.created} ${SECTOR_LABELS[sector] ?? sector} field${data.created === 1 ? "" : "s"}${data.skipped.length ? ` (${data.skipped.length} already existed)` : ""}.`,
        );
      }
      onApplied();
    } catch (err) {
      notifyError(err, "Couldn't apply the field set.");
    } finally {
      setApplying(null);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="mb-1 flex items-center gap-2">
        <Layers className="size-4 text-[var(--primary)]" />
        <h3 className="text-sm font-semibold text-[var(--text)]">Sector field sets</h3>
      </div>
      <p className="mb-4 text-xs text-[var(--text-muted)]">
        Curated, optional fields for your industry — bound to that sector&apos;s
        item types so they appear where they make sense. New projects created
        from a sector template get these automatically; applying here is
        idempotent and never overwrites fields you already have.
      </p>
      <div className="flex flex-wrap gap-2">
        {SECTOR_FIELD_SECTORS.map((sector) => (
          <Button
            key={sector}
            variant="outline"
            size="sm"
            disabled={applying !== null}
            onClick={() => void apply(sector)}
            title={`${SECTOR_FIELD_TEMPLATES[sector].length} fields: ${SECTOR_FIELD_TEMPLATES[sector]
              .map((f) => f.name)
              .join(", ")}`}
          >
            {applying === sector ? "Applying…" : SECTOR_LABELS[sector] ?? sector}
          </Button>
        ))}
      </div>
    </section>
  );
}
