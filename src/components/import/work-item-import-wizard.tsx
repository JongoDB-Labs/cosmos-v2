"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, ArrowLeft, ArrowRight, CheckCircle2, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import { parseImportFile, type ParsedFile } from "@/lib/import/parse-file";
import {
  TARGET_FIELDS,
  IGNORE,
  guessTarget,
  guessPriority,
  type ImportReport,
  type ImportValueMaps,
  type PriorityValue,
  type TargetFieldId,
} from "@/lib/import/work-item-fields";

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

type Step = "upload" | "fields" | "values" | "review";
const PRIORITIES: PriorityValue[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

const selectCls =
  "h-8 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-sm outline-none focus-visible:border-ring";

export function WorkItemImportWizard(props: WizardProps) {
  const { orgId, projectId, orgSlug, projectKey, columns, types, members, defaults } = props;
  const router = useRouter();

  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [parsing, setParsing] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [valueMaps, setValueMaps] = useState<ImportValueMaps>({});
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState<ImportReport | null>(null);

  // ── Upload ──
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
      for (const h of result.headers) guessed[h] = guessTarget(h) || IGNORE;
      setMapping(guessed);
      setStep("fields");
    } catch (err) {
      notifyError(err, "Couldn't read that file. Use CSV, TSV, or XLSX.");
    } finally {
      setParsing(false);
    }
  }

  // The header chosen for each value-mapped target (first wins).
  const mappedHeaderFor = useMemo(() => {
    const find = (t: TargetFieldId) =>
      parsed?.headers.find((h) => mapping[h] === t);
    return {
      status: find("status"),
      type: find("type"),
      priority: find("priority"),
      assignee: find("assignee"),
    };
  }, [parsed, mapping]);

  const hasTitle = parsed?.headers.some((h) => mapping[h] === "title");

  function distinctValues(header: string | undefined): string[] {
    if (!header || !parsed) return [];
    const set = new Set<string>();
    for (const r of parsed.rows) {
      const v = (r[header] ?? "").trim();
      if (v) set.add(v);
    }
    return Array.from(set); // full set — seeded into value-maps so nothing silently defaults
  }

  // ── Enter value-mapping: seed best-guess targets ──
  function goToValues() {
    const next: ImportValueMaps = { status: {}, type: {}, priority: {}, assignee: {} };
    for (const v of distinctValues(mappedHeaderFor.status)) {
      const hit = columns.find(
        (c) => c.name.toLowerCase() === v.toLowerCase() || c.key.toLowerCase() === v.toLowerCase(),
      );
      next.status![v] = hit?.key ?? defaults.columnKey;
    }
    for (const v of distinctValues(mappedHeaderFor.type)) {
      const hit = types.find((t) => t.name.toLowerCase() === v.toLowerCase());
      next.type![v] = hit?.id ?? defaults.workItemTypeId;
    }
    for (const v of distinctValues(mappedHeaderFor.priority)) {
      next.priority![v] = (guessPriority(v) || "MEDIUM") as PriorityValue;
    }
    for (const v of distinctValues(mappedHeaderFor.assignee)) {
      const hit = members.find(
        (m) => m.email.toLowerCase() === v.toLowerCase() || m.name.toLowerCase() === v.toLowerCase(),
      );
      next.assignee![v] = hit?.id ?? "";
    }
    setValueMaps(next);
    setStep("values");
  }

  const hasAnyValueMap =
    mappedHeaderFor.status || mappedHeaderFor.type || mappedHeaderFor.priority || mappedHeaderFor.assignee;

  // ── Submit (validate / commit) ──
  async function submit(mode: "validate" | "commit") {
    if (!parsed) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/work-items/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode,
            mapping,
            valueMaps,
            rows: parsed.rows,
            defaults: {
              columnKey: defaults.columnKey,
              workItemTypeId: defaults.workItemTypeId,
              priority: "MEDIUM",
            },
          }),
        },
      );
      if (!res.ok) throw new Error(`Import failed (${res.status})`);
      const data = (await res.json()) as ImportReport | { data: ImportReport };
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
          Created {committed.created ?? 0}, updated {committed.updated ?? 0}
          {committed.skipped ? `, skipped ${committed.skipped}` : ""}.
          {committed.createdCycles
            ? ` Created ${committed.createdCycles} new sprint${committed.createdCycles === 1 ? "" : "s"}.`
            : ""}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button onClick={() => router.push(`/${orgSlug}/projects/${projectKey}`)}>
            Go to board
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setCommitted(null);
              setReport(null);
              setParsed(null);
              setMapping({});
              setValueMaps({});
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
        <StepBadge step={step} s="upload" n={1} label="Upload" />
        <ArrowRight className="h-4 w-4 text-[var(--text-muted)]" />
        <StepBadge step={step} s="fields" n={2} label="Map fields" />
        <ArrowRight className="h-4 w-4 text-[var(--text-muted)]" />
        <StepBadge step={step} s="values" n={3} label="Map values" />
        <ArrowRight className="h-4 w-4 text-[var(--text-muted)]" />
        <StepBadge step={step} s="review" n={4} label="Review & import" />
      </div>

      {/* STEP 1 — Upload */}
      {step === "upload" && (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-[var(--border)] bg-[var(--surface)] p-12 text-center hover:border-[var(--primary)]/50">
          <Upload className="h-8 w-8 text-[var(--text-muted)]" />
          <div>
            <p className="text-sm font-medium text-[var(--text)]">
              {parsing ? "Reading…" : "Upload a CSV, TSV, or Excel (.xlsx) export"}
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              From Jira: Issues → Export → CSV/Excel. We map the columns next.
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
          {!hasTitle && (
            <div className="flex items-center gap-2 rounded-md border border-[var(--status-critical-text)]/30 bg-destructive/10 px-3 py-2 text-sm text-[var(--status-critical-text)]">
              <AlertTriangle className="h-4 w-4" /> Map one column to <b>Summary / Title</b> to continue.
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
                  const sample = parsed.rows.find((r) => (r[h] ?? "").trim())?.[h] ?? "";
                  return (
                    <tr key={h} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2 font-medium text-[var(--text)]">{h}</td>
                      <td className="max-w-[18rem] truncate px-3 py-2 text-[var(--text-muted)]">{sample}</td>
                      <td className="px-3 py-2">
                        <select
                          className={selectCls}
                          value={mapping[h] ?? IGNORE}
                          onChange={(e) =>
                            setMapping((m) => ({ ...m, [h]: e.target.value }))
                          }
                        >
                          <option value={IGNORE}>— Ignore —</option>
                          {TARGET_FIELDS.map((t) => (
                            <option key={t.id} value={t.id}>{t.label}</option>
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
            <Button
              disabled={!hasTitle || busy}
              onClick={() => (hasAnyValueMap ? goToValues() : void submit("validate"))}
            >
              {busy
                ? "Checking…"
                : hasAnyValueMap
                  ? "Next: map values"
                  : "Next: review"}{" "}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* STEP 3 — Map values */}
      {step === "values" && parsed && (
        <div className="space-y-5">
          <p className="text-sm text-[var(--text-muted)]">
            Map the distinct values from your file to this workspace.
          </p>

          {mappedHeaderFor.status && (
            <ValueGroup title="Status → Board column" values={distinctValues(mappedHeaderFor.status)}
              value={(v) => valueMaps.status?.[v] ?? defaults.columnKey}
              onChange={(v, target) => setValueMaps((m) => ({ ...m, status: { ...m.status, [v]: target } }))}
              options={columns.map((c) => ({ value: c.key, label: c.name }))} />
          )}
          {mappedHeaderFor.type && (
            <ValueGroup title="Issue type → Work-item type" values={distinctValues(mappedHeaderFor.type)}
              value={(v) => valueMaps.type?.[v] ?? defaults.workItemTypeId}
              onChange={(v, target) => setValueMaps((m) => ({ ...m, type: { ...m.type, [v]: target } }))}
              options={types.map((t) => ({ value: t.id, label: t.name }))} />
          )}
          {mappedHeaderFor.priority && (
            <ValueGroup title="Priority" values={distinctValues(mappedHeaderFor.priority)}
              value={(v) => valueMaps.priority?.[v] ?? "MEDIUM"}
              onChange={(v, target) => setValueMaps((m) => ({ ...m, priority: { ...m.priority, [v]: target as PriorityValue } }))}
              options={PRIORITIES.map((p) => ({ value: p, label: p[0] + p.slice(1).toLowerCase() }))} />
          )}
          {mappedHeaderFor.assignee && (
            <ValueGroup title="Assignee → Member" values={distinctValues(mappedHeaderFor.assignee)}
              value={(v) => valueMaps.assignee?.[v] ?? ""}
              onChange={(v, target) => setValueMaps((m) => ({ ...m, assignee: { ...m.assignee, [v]: target } }))}
              options={[{ value: "", label: "— Unassigned —" }, ...members.map((m) => ({ value: m.id, label: `${m.name} (${m.email})` }))]} />
          )}

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("fields")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button disabled={busy} onClick={() => void submit("validate")}>
              {busy ? "Checking…" : "Next: review"} <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* STEP 4 — Review */}
      {step === "review" && report && (
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Will create" value={report.willCreate} tone="primary" />
            <Stat label="Will update" value={report.willUpdate} tone="muted" />
            <Stat label="Skipped" value={report.skipped} tone={report.skipped ? "warn" : "muted"} />
          </div>
          {report.errors.length > 0 && (
            <div className="rounded-lg border border-[var(--border)]">
              <div className="border-b border-[var(--border)] px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {report.errors.length} rows with issues (skipped)
              </div>
              <ul className="max-h-48 overflow-y-auto p-2 text-sm">
                {report.errors.map((e, i) => (
                  <li key={i} className="px-2 py-1 text-[var(--text-muted)]">
                    Row {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(report.warnings?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-500/40">
              <div className="border-b border-amber-500/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                {report.warnings!.length} warnings — these rows still import, but a value was dropped
              </div>
              <ul className="max-h-48 overflow-y-auto p-2 text-sm">
                {report.warnings!.map((w, i) => (
                  <li key={i} className="px-2 py-1 text-[var(--text-muted)]">
                    Row {w.row}: {w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(hasAnyValueMap ? "values" : "fields")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button disabled={busy || report.willCreate + report.willUpdate === 0} onClick={() => void submit("commit")}>
              {busy ? "Importing…" : `Import ${report.willCreate + report.willUpdate} items`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepBadge({
  step,
  s,
  n,
  label,
}: {
  step: Step;
  s: Step;
  n: number;
  label: string;
}) {
  const order: Step[] = ["upload", "fields", "values", "review"];
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
      <span
        className={cn(
          "text-sm",
          active ? "font-medium text-[var(--text)]" : "text-[var(--text-muted)]",
        )}
      >
        {label}
      </span>
    </div>
  );
}

function ValueGroup({
  title,
  values,
  value,
  onChange,
  options,
}: {
  title: string;
  values: string[];
  value: (v: string) => string;
  onChange: (v: string, target: string) => void;
  options: { value: string; label: string }[];
}) {
  if (values.length === 0) return null;
  const RENDER_CAP = 200;
  const shown = values.slice(0, RENDER_CAP);
  const hiddenCount = values.length - shown.length;
  return (
    <div className="rounded-lg border border-[var(--border)]">
      <div className="border-b border-[var(--border)] px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {title}
        {hiddenCount > 0 && (
          <span className="ml-2 font-normal normal-case">
            (showing first {RENDER_CAP}; {hiddenCount} more use the auto-matched
            default)
          </span>
        )}
      </div>
      <div className="divide-y divide-[var(--border)]">
        {shown.map((v) => (
          <div key={v} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{v}</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
            <select className={selectCls} value={value(v)} onChange={(e) => onChange(v, e.target.value)}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
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
