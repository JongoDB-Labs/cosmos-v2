"use client";

import { useState } from "react";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Download, FileSpreadsheet } from "lucide-react";

/**
 * Export dialog for the PM dashboard. Lets the user pick which of the eight
 * register trackers to export and whether to get full-fidelity template files
 * (separate → a ZIP, each a populated copy of the real tracker spreadsheet with
 * styles/formulas/charts intact) or one flat convenience workbook (combined).
 *
 * Controlled via `open`/`onOpenChange` — pm-dashboard.tsx owns the trigger.
 */

type ExportMode = "separate" | "combined";

const TRACKER_OPTIONS: { id: string; label: string; note: string }[] = [
  { id: "risks", label: "Risk Register", note: "Likelihood × Impact, level bands, summary dashboard" },
  { id: "changes", label: "Change Log", note: "Cost / schedule impact, status rollup" },
  { id: "blockers", label: "Blocked Items", note: "Owner, what-unblocks, days-open" },
  { id: "schedule", label: "Schedule Variance", note: "Baseline vs projected, variance, escalation" },
  { id: "deliverables", label: "Deliverable Register", note: "CDRLs, early/late, govt review window" },
  { id: "staffing", label: "Staffing & Personnel", note: "CAC / training / access / NDA compliance" },
  { id: "vendors", label: "Vendors & Subs", note: "Ceiling / funded / burn, mod + invoice logs" },
  { id: "burn", label: "Financial / Burn", note: "19-tab CLIN burn model with charts" },
];

const ALL_IDS = TRACKER_OPTIONS.map((t) => t.id);

export interface ExportDialogProps {
  orgId: string;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportDialog({ orgId, projectId, open, onOpenChange }: ExportDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(ALL_IDS));
  const [mode, setMode] = useState<ExportMode>("separate");
  const [downloading, setDownloading] = useState(false);

  const allChecked = selected.size === ALL_IDS.length;
  const noneChecked = selected.size === 0;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allChecked ? new Set() : new Set(ALL_IDS));

  async function download() {
    if (noneChecked) return;
    setDownloading(true);
    try {
      // Preserve the canonical tracker order regardless of click order.
      const trackers = ALL_IDS.filter((id) => selected.has(id));
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/export/xlsx`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trackers, mode }),
        },
      );
      if (!res.ok) throw new Error(`Export failed (${res.status})`);

      const blob = await res.blob();
      const filename = filenameFromDisposition(res.headers.get("Content-Disposition"))
        ?? defaultName(mode, trackers.length);

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onOpenChange(false);
    } catch (err) {
      notifyError(err, "Couldn't export the trackers.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="size-5" /> Export trackers
          </DialogTitle>
          <DialogDescription>
            Choose which registers to export and the format. Live Cosmos data is
            written into your real tracker spreadsheets.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Tracker selection */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Registers
            </span>
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {allChecked ? "Clear all" : "Select all"}
            </button>
          </div>
          <div className="grid gap-1.5">
            {TRACKER_OPTIONS.map((t) => (
              <Label
                key={t.id}
                htmlFor={`export-${t.id}`}
                className="flex cursor-pointer items-start gap-2.5 rounded-md p-2 hover:bg-muted/50"
              >
                <Checkbox
                  id={`export-${t.id}`}
                  checked={selected.has(t.id)}
                  onChange={() => toggle(t.id)}
                  className="mt-0.5"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm leading-none font-medium">{t.label}</span>
                  <span className="text-xs text-muted-foreground">{t.note}</span>
                </span>
              </Label>
            ))}
          </div>

          {/* Format choice */}
          <div className="mt-1 flex flex-col gap-2 border-t pt-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Format
            </span>
            <ModeOption
              id="mode-separate"
              checked={mode === "separate"}
              onSelect={() => setMode("separate")}
              title="Separate template files"
              note="Full fidelity — each tracker as its own styled spreadsheet (ZIP if more than one), with formulas and charts."
            />
            <ModeOption
              id="mode-combined"
              checked={mode === "combined"}
              onSelect={() => setMode("combined")}
              title="Combined workbook"
              note="One convenience file, a single flat data sheet per tracker. No styling, formulas, or charts."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={downloading}>
            Cancel
          </Button>
          <Button onClick={download} disabled={downloading || noneChecked}>
            {downloading ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Download className="mr-1 size-3.5" />
            )}
            {downloading ? "Preparing…" : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeOption({
  id,
  checked,
  onSelect,
  title,
  note,
}: {
  id: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  note: string;
}) {
  return (
    <Label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-2.5 rounded-md p-2 hover:bg-muted/50"
    >
      <input
        id={id}
        type="radio"
        name="export-mode"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 size-4 cursor-pointer accent-[var(--primary)]"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm leading-none font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </span>
    </Label>
  );
}

/** Parse `filename="x"` out of a Content-Disposition header. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const m = /filename="?([^"]+)"?/.exec(header);
  return m ? m[1] : null;
}

function defaultName(mode: ExportMode, count: number): string {
  if (mode === "combined") return "pm-dashboard.xlsx";
  return count > 1 ? "pm-trackers.zip" : "pm-tracker.xlsx";
}
