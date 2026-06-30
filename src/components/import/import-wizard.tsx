"use client";

/**
 * Generalized import wizard. Adds a FIRST step — "What are you importing?" — a
 * card grid of every importable entity. Selecting **Work Items** runs the
 * EXISTING work-item flow unchanged (WorkItemImportWizard → /work-items/import,
 * with its value-maps + defaults + externalId idempotency). Selecting any other
 * entity runs the GENERIC flow (this file): upload → map columns → validate →
 * import, posting { entity, mode, mapping, rows } to /import.
 *
 * The generic flow deliberately has NO interactive value-mapping step — the
 * server coerces enums tolerantly and reports any unrecognized values as
 * per-row warnings in the report.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import * as Icons from "lucide-react";
import {
  Upload,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  FileSpreadsheet,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import { parseImportFile, type ParsedFile } from "@/lib/import/parse-file";
import { WorkItemImportWizard } from "@/components/import/work-item-import-wizard";
import {
  ENTITY_DEFS,
  IGNORE,
  getEntityDef,
  guessFieldForHeader,
  type EntityDef,
  type EntityImportReport,
} from "@/lib/import/entity-fields";

interface ColumnOpt { key: string; name: string }
interface TypeOpt { id: string; name: string }
interface MemberOpt { id: string; name: string; email: string }

interface WizardProps {
  orgId: string;
  projectId: string;
  orgSlug: string;
  projectKey: string;
  columns: ColumnOpt[];
  types: TypeOpt[];
  members: MemberOpt[];
  defaults: { columnKey: string; workItemTypeId: string };
}

/** "work-item" is the sentinel for the existing dedicated flow. */
type Selected = "work-item" | string | null;

const selectCls =
  "h-8 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-sm outline-none focus-visible:border-ring";

function iconFor(name: string): LucideIcon {
  const Comp = (Icons as unknown as Record<string, LucideIcon>)[name];
  return Comp ?? ListChecks;
}

export function ImportWizard(props: WizardProps) {
  const [selected, setSelected] = useState<Selected>(null);

  // ── Step 1: entity picker ──
  if (selected === null) {
    return <EntityPicker onPick={setSelected} />;
  }

  // ── Work Items → the EXISTING flow, untouched ──
  if (selected === "work-item") {
    return (
      <div className="space-y-4">
        <BackToPicker onBack={() => setSelected(null)} label="Work Items" />
        <WorkItemImportWizard
          orgId={props.orgId}
          projectId={props.projectId}
          orgSlug={props.orgSlug}
          projectKey={props.projectKey}
          columns={props.columns}
          types={props.types}
          members={props.members}
          defaults={props.defaults}
        />
      </div>
    );
  }

  // ── Any registry entity → the generic flow ──
  const def = getEntityDef(selected);
  if (!def) {
    return <EntityPicker onPick={setSelected} />;
  }
  return (
    <div className="space-y-4">
      <BackToPicker onBack={() => setSelected(null)} label={def.label} />
      <GenericImportFlow
        def={def}
        orgId={props.orgId}
        projectId={props.projectId}
        orgSlug={props.orgSlug}
        projectKey={props.projectKey}
      />
    </div>
  );
}

function BackToPicker({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> Change type
      </Button>
      <span>
        Importing <b className="text-[var(--text)]">{label}</b>
      </span>
    </div>
  );
}

function EntityPicker({ onPick }: { onPick: (k: Selected) => void }) {
  const cards: { key: Selected; label: string; icon: string; blurb: string }[] = [
    {
      key: "work-item",
      label: "Work Items",
      icon: "ListChecks",
      blurb: "Issues / tasks / epics from a Jira, Linear, or CSV export — with status + assignee mapping.",
    },
    ...ENTITY_DEFS.map((e) => ({ key: e.key, label: e.label, icon: e.icon, blurb: e.blurb })),
  ];

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-[var(--text)]">What are you importing?</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Pick the kind of record. You&apos;ll upload a spreadsheet and map its columns next.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => {
          const Icon = iconFor(c.icon);
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => onPick(c.key)}
              className="group flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition hover:border-[var(--primary)]/60 hover:shadow-sm focus-visible:border-ring focus-visible:outline-none"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--primary-tint)] text-[var(--primary)]">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="font-medium text-[var(--text)]">{c.label}</span>
              </div>
              <p className="text-xs leading-relaxed text-[var(--text-muted)]">{c.blurb}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type GStep = "upload" | "fields" | "review";

function GenericImportFlow({
  def,
  orgId,
  projectId,
  orgSlug,
  projectKey,
}: {
  def: EntityDef;
  orgId: string;
  projectId: string;
  orgSlug: string;
  projectKey: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<GStep>("upload");
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [parsing, setParsing] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [report, setReport] = useState<EntityImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState<EntityImportReport | null>(null);

  async function onFile(file: File) {
    setParsing(true);
    setFileName(file.name);
    try {
      const result = await parseImportFile(file);
      if (result.rows.length === 0) {
        notifyError(new Error("No rows"), "That file has no data rows.");
        return;
      }
      setParsed(result);
      // Auto-guess the field mapping from header names.
      const guessed: Record<string, string> = {};
      for (const h of result.headers) guessed[h] = guessFieldForHeader(def, h) || IGNORE;
      setMapping(guessed);
      setStep("fields");
    } catch (err) {
      notifyError(err, "Couldn't read that file. Use CSV, TSV, or XLSX.");
    } finally {
      setParsing(false);
    }
  }

  // A required field is satisfied when some column maps to it.
  const missingRequired = useMemo(() => {
    if (!parsed) return def.fields.filter((f) => f.required).map((f) => f.label);
    const mappedKeys = new Set(Object.values(mapping));
    return def.fields.filter((f) => f.required && !mappedKeys.has(f.key)).map((f) => f.label);
  }, [parsed, mapping, def]);

  async function submit(mode: "validate" | "commit") {
    if (!parsed) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity: def.key, mode, mapping, rows: parsed.rows }),
        },
      );
      if (!res.ok) throw new Error(`Import failed (${res.status})`);
      const data = (await res.json()) as EntityImportReport | { data: EntityImportReport };
      const rep = "data" in data ? data.data : data;
      if (mode === "validate") {
        setReport(rep);
        setStep("review");
      } else {
        setCommitted(rep);
      }
    } catch (err) {
      notifyError(err, "The import couldn't be processed.");
    } finally {
      setBusy(false);
    }
  }

  // ── committed success view ──
  if (committed) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
        <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-[var(--status-success-text,green)]" />
        <h3 className="text-lg font-semibold">Import complete</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Created {committed.created ?? 0}
          {committed.skipped ? `, skipped ${committed.skipped}` : ""}.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button onClick={() => router.push(`/${orgSlug}/projects/${projectKey}`)}>
            Go to project
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setCommitted(null);
              setReport(null);
              setParsed(null);
              setMapping({});
              setFileName("");
              setStep("upload");
            }}
          >
            Import another file
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <GStepBadge step={step} s="upload" n={1} label="Upload" />
        <ArrowRight className="h-4 w-4 text-[var(--text-muted)]" />
        <GStepBadge step={step} s="fields" n={2} label="Map fields" />
        <ArrowRight className="h-4 w-4 text-[var(--text-muted)]" />
        <GStepBadge step={step} s="review" n={3} label="Review & import" />
      </div>

      {/* STEP 1 — Upload */}
      {step === "upload" && (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-[var(--border)] bg-[var(--surface)] p-12 text-center hover:border-[var(--primary)]/50">
          <Upload className="h-8 w-8 text-[var(--text-muted)]" />
          <div>
            <p className="text-sm font-medium text-[var(--text)]">
              {parsing ? "Reading…" : "Upload a CSV, TSV, or Excel (.xlsx) file"}
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              We map the columns to {def.label.toLowerCase()} fields next.
            </p>
          </div>
          <input
            type="file"
            accept=".csv,.tsv,.xlsx,.xls,text/csv"
            className="hidden"
            disabled={parsing}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
        </label>
      )}

      {/* STEP 2 — Map fields */}
      {step === "fields" && parsed && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <FileSpreadsheet className="h-4 w-4" />
            {fileName} — {parsed.rows.length} rows, {parsed.headers.length} columns
          </div>
          {missingRequired.length > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-[var(--status-critical-text)]/30 bg-destructive/10 px-3 py-2 text-sm text-[var(--status-critical-text)]">
              <AlertTriangle className="h-4 w-4" /> Map a column to{" "}
              <b>{missingRequired.join(", ")}</b> to continue.
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--surface)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <tr>
                  <th className="px-3 py-2 font-medium">Source column</th>
                  <th className="px-3 py-2 font-medium">Sample</th>
                  <th className="px-3 py-2 font-medium">Import as</th>
                </tr>
              </thead>
              <tbody>
                {parsed.headers.map((h) => {
                  const sample = parsed.rows.find((r) => cellStr(r[h]))?.[h] ?? "";
                  return (
                    <tr key={h} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2 font-medium text-[var(--text)]">{h}</td>
                      <td className="max-w-[18rem] truncate px-3 py-2 text-[var(--text-muted)]">
                        {cellStr(sample)}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className={selectCls}
                          value={mapping[h] ?? IGNORE}
                          onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}
                        >
                          <option value={IGNORE}>— Ignore —</option>
                          {def.fields.map((f) => (
                            <option key={f.key} value={f.key}>
                              {f.label}
                              {f.required ? " *" : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("upload")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button disabled={missingRequired.length > 0 || busy} onClick={() => void submit("validate")}>
              {busy ? "Checking…" : "Next: review"} <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* STEP 3 — Review */}
      {step === "review" && report && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Will create" value={report.willCreate} tone="primary" />
            <Stat label="Skipped (exists / invalid)" value={report.skipped} tone={report.skipped ? "warn" : "muted"} />
          </div>
          {report.errors.length > 0 && (
            <div className="rounded-lg border border-[var(--border)]">
              <div className="border-b border-[var(--border)] px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {report.errors.length} notes (skipped rows + value warnings)
              </div>
              <ul className="max-h-48 overflow-y-auto p-2 text-sm">
                {report.errors.map((e, i) => (
                  <li key={i} className="px-2 py-1 text-[var(--text-muted)]">
                    {e.row > 0 ? `Row ${e.row}: ` : ""}
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("fields")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button disabled={busy || report.willCreate === 0} onClick={() => void submit("commit")}>
              {busy ? "Importing…" : `Import ${report.willCreate} ${def.label.toLowerCase()}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function cellStr(v: string | number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

function GStepBadge({ step, s, n, label }: { step: GStep; s: GStep; n: number; label: string }) {
  const order: GStep[] = ["upload", "fields", "review"];
  const active = step === s;
  const done = order.indexOf(step) > order.indexOf(s);
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
          active
            ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
            : done
              ? "bg-[var(--primary-tint)] text-[var(--primary)]"
              : "bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)]",
        )}
      >
        {done ? "✓" : n}
      </span>
      <span className={cn("text-sm", active ? "font-medium text-[var(--text)]" : "text-[var(--text-muted)]")}>
        {label}
      </span>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "primary" | "muted" | "warn" }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-center">
      <div
        className={cn(
          "text-2xl font-semibold",
          tone === "primary" && "text-[var(--primary)]",
          tone === "warn" && "text-[var(--status-critical-text)]",
          tone === "muted" && "text-[var(--text)]",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-[var(--text-muted)]">{label}</div>
    </div>
  );
}
