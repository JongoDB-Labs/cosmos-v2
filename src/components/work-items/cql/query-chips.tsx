"use client";

/**
 * Basic mode: the query as chips, `[Field] [operator ▾] [values ▾] [×]`
 * (Linear's anatomy), plus "Add filter" and a Match all / Match any switch
 * that applies at the top level only. Groups are Advanced mode's job.
 *
 * The chips are a VIEW of the query text: every change prints the whole query
 * back (`fromChips` → `printCql`) and the caller puts it in the URL. A chip
 * still being built ("Assignee is any of …", nothing picked) lives here as a
 * draft until it says something, so a half-built chip never reaches the query.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import type { SearchableOption } from "@/components/ui/searchable-select";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { cn } from "@/lib/utils";
import { sameField, type CqlValue, type FieldRef } from "@/lib/query/ast";
import type { Chip } from "@/lib/query/basic";
import {
  chipField,
  chipFields,
  chipOps,
  datePresets,
  fromEdit,
  newEdit,
  opLabel,
  parseValueText,
  presetEdit,
  presetOf,
  toEdit,
  valueKey,
  valueLabel,
  withOp,
  DATE_PRESETS,
  type ChipField,
  type ChipOp,
  type DatePreset,
  type EditChip,
} from "@/lib/query/chip-ops";
import { SYSTEM_FIELD_IDS } from "@/lib/query/fields";
import type { Suggestion } from "@/lib/query/suggest.server";
import type { CqlClientSchema } from "./use-cql";

const fieldName = (f: FieldRef) => (f.kind === "sys" ? f.id : f.key);
const fieldKey = (f: FieldRef) => (f.kind === "sys" ? `sys:${f.id}` : `cf:${f.key}`);

/** Values `/cql/suggest` offers for a field, keyed like every client query. */
function useSuggestions(orgId: string, field: string, enabled: boolean) {
  const key = useOrgQueryKey("cql-suggest", field);
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const qs = new URLSearchParams({ field, prefix: "", limit: "100" });
      return (await jsonFetch<{ items: Suggestion[] }>(`/api/v1/orgs/${orgId}/cql/suggest?${qs}`)).items;
    },
    enabled,
    staleTime: 60_000,
  });
}

export interface QueryChipsProps {
  orgId: string;
  schema: CqlClientSchema;
  chips: Chip[];
  matchAny: boolean;
  onChange: (chips: Chip[], matchAny: boolean) => void;
  /**
   * Fields already constrained by a query these chips do NOT show.
   *
   * Only "Add filter" beside the CQL editor passes this: there `chips` is
   * empty by design (the control appends one clause to the text and never
   * reprints the tree), so `used` has nothing to go on and would offer a field
   * the query already filters on.
   */
  excludeFields?: FieldRef[];
  /** Hide the Match all / Match any switch — it speaks for the whole query. */
  hideMatch?: boolean;
}

export function QueryChips({ orgId, schema, chips, matchAny, onChange, excludeFields, hideMatch }: QueryChipsProps) {
  const [drafts, setDrafts] = useState<EditChip[]>([]);
  const fields = useMemo(() => chipFields(schema.customFields, SYSTEM_FIELD_IDS), [schema.customFields]);
  const info = (f: FieldRef) => chipField(f, schema.customFields);
  const used = (f: FieldRef) =>
    chips.some((c) => sameField(c.field, f)) ||
    drafts.some((d) => sameField(d.field, f)) ||
    (excludeFields ?? []).some((x) => sameField(x, f));

  // Picking a person straight from "Add filter" (Linear's "type a value").
  const people = useSuggestions(orgId, "assignee", true);

  function commitEdit(index: number, e: EditChip) {
    const c = fromEdit(e);
    if (c) onChange(chips.map((x, i) => (i === index ? c : x)), matchAny);
    else {
      // Emptied out: it becomes a draft again rather than vanishing mid-edit.
      setDrafts((d) => [...d, e]);
      onChange(chips.filter((_, i) => i !== index), matchAny);
    }
  }

  function editDraft(index: number, e: EditChip) {
    const c = fromEdit(e);
    if (c) {
      setDrafts((d) => d.filter((_, i) => i !== index));
      onChange([...chips, c], matchAny);
    } else setDrafts((d) => d.map((x, i) => (i === index ? e : x)));
  }

  const addOptions: SearchableOption[] = useMemo(() => {
    const out: SearchableOption[] = fields
      .filter((f) => !used(f.field))
      .map((f) => ({ value: `field|${fieldKey(f.field)}`, label: f.label }));
    for (const p of (people.data ?? []).filter((s) => s.kind === "user" || s.label === "me")) {
      for (const id of ["assignee", "reporter"] as const) {
        if (used({ kind: "sys", id })) continue;
        out.push({
          value: `value|${id}|${p.insert}`,
          label: `${id === "assignee" ? "Assignee" : "Reporter"}: ${p.label}`,
          ...(p.detail ? { searchText: p.detail } : {}),
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, chips, drafts, excludeFields, people.data]);

  function add(choice: string | null) {
    if (!choice) return;
    const [kind, a] = choice.split("|");
    if (kind === "field") {
      const f = fields.find((x) => fieldKey(x.field) === a);
      if (f) setDrafts((d) => [...d, newEdit(f)]);
      return;
    }
    const v = parseValueText(choice.slice(`value|${a}|`.length));
    if (v) onChange([...chips, { kind: "cmp", field: { kind: "sys", id: a as "assignee" }, cmp: "eq", value: v }], matchAny);
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="query-chips">
      {!hideMatch && chips.length + drafts.length > 1 && (
        <div className="inline-flex overflow-hidden rounded-md border border-[var(--border)] text-xs" role="group" aria-label="Match">
          {([false, true] as const).map((any) => (
            <button
              key={String(any)}
              type="button"
              aria-pressed={matchAny === any}
              onClick={() => matchAny !== any && onChange(chips, any)}
              className={cn(
                "px-2 py-1",
                matchAny === any ? "bg-[var(--primary)] text-[var(--primary-foreground,white)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
              )}
            >
              {any ? "Match any" : "Match all"}
            </button>
          ))}
        </div>
      )}
      {chips.map((c, i) => {
        const f = info(c.field);
        return (
          <ChipEditor
            key={`c-${fieldKey(c.field)}`}
            orgId={orgId}
            field={f}
            fallbackLabel={fieldName(c.field)}
            edit={toEdit(c, f)}
            onChange={(e) => commitEdit(i, e)}
            onRemove={() => onChange(chips.filter((_, j) => j !== i), matchAny)}
          />
        );
      })}
      {drafts.map((d, i) => (
        <ChipEditor
          key={`d-${fieldKey(d.field)}`}
          orgId={orgId}
          field={info(d.field)}
          fallbackLabel={fieldName(d.field)}
          edit={d}
          draft
          onChange={(e) => editDraft(i, e)}
          onRemove={() => setDrafts((x) => x.filter((_, j) => j !== i))}
        />
      ))}
      <SearchableSelect
        value={null}
        onValueChange={add}
        options={addOptions}
        placeholder="Add filter"
        searchPlaceholder="Field or person…"
        size="sm"
        aria-label="Add filter"
        className="w-auto"
      />
    </div>
  );
}

// ── one chip ─────────────────────────────────────────────────────────────────

function ChipEditor({
  orgId,
  field,
  fallbackLabel,
  edit,
  draft,
  onChange,
  onRemove,
}: {
  orgId: string;
  field: ChipField | null;
  fallbackLabel: string;
  edit: EditChip;
  draft?: boolean;
  onChange: (e: EditChip) => void;
  onRemove: () => void;
}) {
  const label = field?.label ?? fallbackLabel;
  const ops = field ? chipOps(field) : [edit.op];
  if (!ops.includes(edit.op)) ops.push(edit.op);
  const opItems = Object.fromEntries(ops.map((o) => [o, field ? opLabel(o, field.value) : o]));
  const needsValue = edit.op !== "empty" && edit.op !== "notEmpty";

  return (
    <div
      role="group"
      aria-label={`Filter: ${label}`}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border bg-[var(--bg)] py-0.5 pl-2 pr-0.5 text-xs",
        draft ? "border-dashed border-[var(--primary)]" : "border-[var(--border)]",
      )}
    >
      <span className="font-medium text-[var(--text)]">{label}</span>
      {ops.length > 1 ? (
        <Select items={opItems} value={edit.op} onValueChange={(v) => v && onChange(withOp(edit, v as ChipOp))}>
          <SelectTrigger size="sm" aria-label={`${label} operator`} className="h-6 border-0 px-1 text-xs text-[var(--text-muted)]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ops.map((o) => (
              <SelectItem key={o} value={o}>
                {opItems[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-[var(--text-muted)]">{opItems[edit.op]}</span>
      )}
      {needsValue && field && <ValueEditor orgId={orgId} field={field} label={label} edit={edit} onChange={onChange} />}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}

function ValueEditor({ orgId, field, label, edit, onChange }: { orgId: string; field: ChipField; label: string; edit: EditChip; onChange: (e: EditChip) => void }) {
  const k = field.value.kind;
  if (edit.op === "contains" || edit.op === "notContains") {
    return <TextValue label={label} value={edit.text} onCommit={(text) => onChange({ ...edit, text })} />;
  }
  if (k === "bool") {
    const v = edit.values[0];
    const cur = v?.t === "bool" ? String(v.v) : "true";
    return (
      <Select items={{ true: "Yes", false: "No" }} value={cur} onValueChange={(x) => x && onChange({ ...edit, values: [{ t: "bool", v: x === "true" }] })}>
        <SelectTrigger size="sm" aria-label={`${label} value`} className="h-6 border-0 px-1 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (k === "date" || k === "datetime" || k === "number" || k === "duration") {
    return <OrderedValue field={field} label={label} edit={edit} onChange={onChange} />;
  }
  return <ListValue orgId={orgId} field={field} label={label} edit={edit} onChange={onChange} />;
}

/** Refs, enums and select options: a searchable multi-select. */
function ListValue({ orgId, field, label, edit, onChange }: { orgId: string; field: ChipField; label: string; edit: EditChip; onChange: (e: EditChip) => void }) {
  const kind = field.value;
  const local = kind.kind === "enum" ? kind.values : field.options;
  const remote = useSuggestions(orgId, fieldName(field.field), !local);
  const options = useMemo(() => {
    const out: SearchableOption[] = [];
    const seen = new Set<string>();
    const push = (v: CqlValue | null, text: string, detail?: string) => {
      if (!v) return;
      const key = valueKey(v);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ value: key, label: text, ...(detail ? { searchText: detail } : {}) });
    };
    if (local) for (const o of local) push({ t: "str", v: o }, o);
    for (const s of remote.data ?? []) push(parseValueText(s.insert), s.label, s.detail);
    // A value typed in the CQL editor that is not in the first page still shows.
    for (const v of edit.values) push(v, valueLabel(v));
    return out;
  }, [local, remote.data, edit.values]);

  const byKey = (key: string): CqlValue => edit.values.find((v) => valueKey(v) === key) ?? parseValueText(key) ?? { t: "str", v: key };
  return (
    <SearchableMultiSelect
      value={edit.values.map(valueKey)}
      onValueChange={(keys) => onChange({ ...edit, values: keys.map(byKey) })}
      options={options}
      placeholder="Pick values…"
      size="sm"
      aria-label={`${label} values`}
      className="h-6 min-w-24 border-0 px-1 text-xs"
    />
  );
}

/** Dates and numbers: presets (dates), then typed values (`2026-01-31`, `-7d`, `3`). */
function OrderedValue({ field, label, edit, onChange }: { field: ChipField; label: string; edit: EditChip; onChange: (e: EditChip) => void }) {
  const presets = datePresets(field);
  const preset = presets.length ? presetOf(edit) : null;
  const temporal = field.value.kind === "date" || field.value.kind === "datetime";
  const placeholder = temporal ? "2026-01-31 or -7d" : field.value.kind === "duration" ? "2d" : "3";
  const setAt = (i: number, text: string) => {
    const v = parseValueText(text);
    const values = [...edit.values];
    if (v) values[i] = v;
    else values.splice(i, 1);
    onChange({ ...edit, values });
  };
  const presetItems: Record<string, string> = { custom: "Custom", ...Object.fromEntries(presets.map((p) => [p.id, p.label])) };
  return (
    <span className="inline-flex items-center gap-1">
      {presets.length > 0 && (
        <Select
          items={presetItems}
          value={preset ?? "custom"}
          onValueChange={(v) => v && v !== "custom" && onChange(presetEdit(edit.field, v as DatePreset))}
        >
          <SelectTrigger size="sm" aria-label={`${label} preset`} className="h-6 border-0 px-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="custom">Custom</SelectItem>
            {presets.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {DATE_PRESETS.find((x) => x.id === p.id)?.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {!preset && (
        <>
          <TextValue label={label} value={edit.values[0] ? valueLabel(edit.values[0]) : ""} placeholder={placeholder} onCommit={(t) => setAt(0, t)} />
          {edit.op === "between" && (
            <>
              <span className="text-[var(--text-muted)]">and</span>
              <TextValue label={`${label} (to)`} value={edit.values[1] ? valueLabel(edit.values[1]) : ""} placeholder={placeholder} onCommit={(t) => setAt(1, t)} />
            </>
          )}
        </>
      )}
    </span>
  );
}

/** A small input that commits on Enter or blur, not per keystroke. */
function TextValue({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  // A new value from outside (the URL, a preset) replaces the draft.
  if (value !== shown) {
    setShown(value);
    setDraft(value);
  }
  const commit = () => draft !== value && onCommit(draft);
  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      onBlur={commit}
      placeholder={placeholder ?? "Value"}
      aria-label={`${label} value`}
      className="h-6 w-32 px-1.5 text-xs"
    />
  );
}
