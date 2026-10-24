"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { COMPARE_OPERATORS, LINK_TYPES, SYSTEM_FIELDS, type FieldRef, type PostActionSpec, type TransitionSpec, type ValidatorSpec } from "@/lib/workflow/definition";
import { cn } from "@/lib/utils";
import { ConditionBuilder } from "./condition-builder";
import { FieldPicker, Pick, SYSTEM_FIELD_LABELS, fieldKey, fieldLabel, parseFieldKey } from "./fields";

type Tab = "restrict" | "input" | "validate" | "perform";
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "restrict", label: "Restrict", hint: "Who may take it." },
  { id: "input", label: "Request input", hint: "What the person is asked for when they take it." },
  { id: "validate", label: "Validate", hint: "What must hold for the move to go through." },
  { id: "perform", label: "Perform actions", hint: "What happens to the item when it does." },
];

const VALIDATOR_KINDS: { value: ValidatorSpec["kind"]; label: string; make: () => ValidatorSpec }[] = [
  { value: "fieldsRequired", label: "Fields are filled in", make: () => ({ kind: "fieldsRequired", fields: [{ system: "assigneeId" }] }) },
  { value: "childrenSettled", label: "Sub-items are done or cancelled", make: () => ({ kind: "childrenSettled" }) },
  { value: "linksSettled", label: "Linked items are done", make: () => ({ kind: "linksSettled", linkType: "BLOCKED_BY" }) },
  { value: "intervalRequired", label: "The item is in a sprint", make: () => ({ kind: "intervalRequired" }) },
  { value: "wipLimit", label: "The board's WIP limit holds", make: () => ({ kind: "wipLimit", scope: "board", hard: true }) },
  { value: "cancelReason", label: "A cancel reason is given", make: () => ({ kind: "cancelReason" }) },
  { value: "field", label: "A field meets a condition", make: () => ({ kind: "field", field: { system: "priority" }, op: "ne", value: "", message: "Check the priority." }) },
];

const ACTION_KINDS: { value: PostActionSpec["kind"]; label: string; make: () => PostActionSpec }[] = [
  { value: "assign", label: "Assign", make: () => ({ kind: "assign", to: "actor" }) },
  { value: "setField", label: "Set a field", make: () => ({ kind: "setField", field: { system: "resolution" }, value: { literal: "" } }) },
  { value: "clearField", label: "Clear a field", make: () => ({ kind: "clearField", field: { system: "resolution" } }) },
  { value: "addLabels", label: "Add labels", make: () => ({ kind: "addLabels", labels: ["label"] }) },
  { value: "removeLabels", label: "Remove labels", make: () => ({ kind: "removeLabels", labels: ["label"] }) },
  { value: "addComment", label: "Add a comment", make: () => ({ kind: "addComment", body: "Moved on." }) },
  { value: "addWatcher", label: "Add a watcher", make: () => ({ kind: "addWatcher", who: "actor" }) },
];

interface StatusOption {
  key: string;
  name: string;
}

/**
 * One transition, edited in four tabs (Jira's verbs): Restrict, Request input,
 * Validate, Perform actions. Edits stay local until Save, which hands the
 * transition (and its id before the edit) back to the draft.
 */
export function TransitionPanel({
  transition,
  statuses,
  customFields,
  open,
  onOpenChange,
  onSave,
  onDelete,
  readOnly = false,
}: {
  transition: TransitionSpec | null;
  statuses: StatusOption[];
  customFields: { key: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (t: TransitionSpec, previousId: string) => void;
  onDelete: (id: string) => void;
  readOnly?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        {transition && (
          <TransitionForm
            key={transition.id}
            initial={transition}
            statuses={statuses}
            customFields={customFields}
            readOnly={readOnly}
            onSave={(t) => onSave(t, transition.id)}
            onDelete={() => onDelete(transition.id)}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function TransitionForm({
  initial,
  statuses,
  customFields,
  readOnly,
  onSave,
  onDelete,
  onCancel,
}: {
  initial: TransitionSpec;
  statuses: StatusOption[];
  customFields: { key: string; name: string }[];
  readOnly: boolean;
  onSave: (t: TransitionSpec) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [t, setT] = useState<TransitionSpec>(initial);
  const [tab, setTab] = useState<Tab>("restrict");
  const update = (patch: Partial<TransitionSpec>) => setT((prev) => ({ ...prev, ...patch }));
  const statusOpts = statuses.map((s) => ({ value: s.key, label: s.name }));
  const valid = t.name.trim().length > 0 && (t.from === "*" || t.from.length > 0);

  return (
    <div className="flex h-full flex-col gap-4">
      <SheetHeader>
        <SheetTitle>Transition: {initial.name}</SheetTitle>
        <SheetDescription>Id {initial.id}: automations and the API refer to it by this.</SheetDescription>
      </SheetHeader>

      <div className="grid gap-3 px-4 text-sm">
        <label className="grid gap-1">
          <span>Name (the button people press)</span>
          <Input value={t.name} onChange={(e) => update({ name: e.target.value })} disabled={readOnly} maxLength={80} />
        </label>
        <div className="grid gap-1">
          <span id="transition-from">From</span>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={t.from === "*"}
                disabled={readOnly}
                onChange={(e) => update({ from: e.target.checked ? "*" : statuses.filter((s) => s.key !== t.to).map((s) => s.key) })}
              />
              Any status
            </label>
            {t.from !== "*" && (
              <SearchableMultiSelect
                aria-label="From statuses"
                value={t.from}
                onValueChange={(v) => update({ from: v })}
                options={statusOpts.filter((o) => o.value !== t.to)}
                size="sm"
                className="min-w-56"
                disabled={readOnly}
              />
            )}
          </div>
        </div>
        <div className="grid gap-1">
          <span>To</span>
          <Pick label="To status" value={t.to} onChange={(to) => update({ to })} options={statusOpts} disabled={readOnly} />
        </div>
        <label className="flex items-center gap-2">
          <Checkbox checked={!!t.hidden} disabled={readOnly} onChange={(e) => update({ hidden: e.target.checked || undefined })} />
          Hidden: only the system and automations take it
        </label>
      </div>

      <div className="px-4">
        <div role="tablist" aria-label="Transition rules" className="flex flex-wrap gap-1 border-b">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              id={`tab-${x.id}`}
              aria-selected={tab === x.id}
              aria-controls={`panel-${x.id}`}
              onClick={() => setTab(x.id)}
              className={cn(
                "-mb-px border-b-2 px-3 py-1.5 text-sm",
                tab === x.id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {x.label}
              <Count n={x.id === "restrict" ? (t.restrict ? 1 : 0) : x.id === "input" ? (t.input?.length ?? 0) : x.id === "validate" ? (t.validate?.length ?? 0) : (t.actions?.length ?? 0)} />
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="space-y-3 py-3">
          <p className="text-xs text-muted-foreground">{TABS.find((x) => x.id === tab)!.hint}</p>
          {tab === "restrict" && (
            <ConditionBuilder value={t.restrict} onChange={(restrict) => update({ restrict })} statuses={statuses} customFields={customFields} />
          )}
          {tab === "input" && <InputList value={t.input ?? []} onChange={(input) => update({ input: input.length ? input : undefined })} customFields={customFields} />}
          {tab === "validate" && (
            <ValidatorList value={t.validate ?? []} onChange={(validate) => update({ validate: validate.length ? validate : undefined })} customFields={customFields} />
          )}
          {tab === "perform" && (
            <ActionList value={t.actions ?? []} onChange={(actions) => update({ actions: actions.length ? actions : undefined })} customFields={customFields} />
          )}
        </div>
      </div>

      {!readOnly && (
        <SheetFooter className="mt-auto flex-row justify-between">
          <Button variant="destructive" onClick={onDelete}>
            Delete transition
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={() => onSave({ ...t, name: t.name.trim() })} disabled={!valid}>
              Apply
            </Button>
          </div>
        </SheetFooter>
      )}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="ml-1 rounded bg-muted px-1 text-[11px]">{n}</span> : null;
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

type InputSpec = NonNullable<TransitionSpec["input"]>[number];

function InputList({ value, onChange, customFields }: { value: InputSpec[]; onChange: (v: InputSpec[]) => void; customFields: { key: string; name: string }[] }) {
  const set = (i: number, patch: Partial<InputSpec>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="space-y-2">
      {value.map((row, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
          <FieldPicker value={row.field} onChange={(field) => set(i, { field })} customFields={customFields} />
          <label className="flex items-center gap-1.5">
            <Checkbox checked={row.required} onChange={(e) => set(i, { required: e.target.checked })} />
            Required
          </label>
          <Input aria-label="Label shown to the person" placeholder={fieldLabel(row.field, customFields)} className="h-8 w-44" value={row.label ?? ""} onChange={(e) => set(i, { label: e.target.value || undefined })} />
          <RemoveButton label={`Remove ${fieldLabel(row.field, customFields)}`} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...value, { field: { system: "resolution" }, required: true }])}>
        <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
        Ask for a field
      </Button>
    </div>
  );
}

function ValidatorList({ value, onChange, customFields }: { value: ValidatorSpec[]; onChange: (v: ValidatorSpec[]) => void; customFields: { key: string; name: string }[] }) {
  const set = (i: number, v: ValidatorSpec) => onChange(value.map((x, j) => (j === i ? v : x)));
  return (
    <div className="space-y-2">
      {value.map((v, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
          <span>{VALIDATOR_KINDS.find((k) => k.value === v.kind)?.label}</span>
          {v.kind === "fieldsRequired" && (
            <FieldsMulti value={v.fields} onChange={(fields) => fields.length > 0 && set(i, { ...v, fields })} customFields={customFields} />
          )}
          {v.kind === "linksSettled" && (
            <Pick label="Link type" value={v.linkType} onChange={(linkType) => set(i, { ...v, linkType: linkType as typeof v.linkType })} options={LINK_TYPES.map((l) => ({ value: l, label: l.replace("_", " ").toLowerCase() }))} />
          )}
          {v.kind === "field" && (
            <>
              <FieldPicker value={v.field} onChange={(field) => set(i, { ...v, field })} customFields={customFields} />
              <Pick label="Comparison" value={v.op} onChange={(op) => set(i, { ...v, op: op as typeof v.op })} options={COMPARE_OPERATORS.map((o) => ({ value: o, label: o }))} className="min-w-20" />
              <Input aria-label="Value" className="h-8 w-32" value={String(v.value ?? "")} onChange={(e) => set(i, { ...v, value: e.target.value })} />
              <Input aria-label="Message when it fails" className="h-8 w-56" value={v.message} onChange={(e) => e.target.value && set(i, { ...v, message: e.target.value })} />
            </>
          )}
          <RemoveButton label="Remove check" onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Pick
        label="Add a check"
        value=""
        placeholder="Add a check…"
        onChange={(k) => {
          const kind = VALIDATOR_KINDS.find((x) => x.value === k);
          if (kind && !(kind.value !== "field" && kind.value !== "fieldsRequired" && value.some((x) => x.kind === kind.value))) onChange([...value, kind.make()]);
        }}
        options={VALIDATOR_KINDS.map(({ value: v, label }) => ({ value: v, label }))}
        className="min-w-56"
      />
    </div>
  );
}

function FieldsMulti({ value, onChange, customFields }: { value: FieldRef[]; onChange: (v: FieldRef[]) => void; customFields: { key: string; name: string }[] }) {
  const options = [
    ...SYSTEM_FIELDS.map((f) => ({ value: `system:${f}`, label: SYSTEM_FIELD_LABELS[f] })),
    ...customFields.map((c) => ({ value: `custom:${c.key}`, label: c.name })),
  ];
  return (
    <SearchableMultiSelect
      aria-label="Fields"
      value={value.map(fieldKey)}
      onValueChange={(keys) => onChange(keys.flatMap((k) => parseFieldKey(k) ?? []))}
      options={options}
      size="sm"
      className="min-w-56"
    />
  );
}

function ActionList({ value, onChange, customFields }: { value: PostActionSpec[]; onChange: (v: PostActionSpec[]) => void; customFields: { key: string; name: string }[] }) {
  const set = (i: number, a: PostActionSpec) => onChange(value.map((x, j) => (j === i ? a : x)));
  return (
    <div className="space-y-2">
      {value.map((a, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
          <span>{ACTION_KINDS.find((k) => k.value === a.kind)?.label}</span>
          {a.kind === "assign" && (
            <Pick
              label="Assign to"
              value={typeof a.to === "string" ? a.to : "actor"}
              onChange={(to) => set(i, { ...a, to: to as "actor" | "creator" | "unassigned" })}
              options={[
                { value: "actor", label: "the person moving it" },
                { value: "creator", label: "its creator" },
                { value: "unassigned", label: "nobody" },
              ]}
            />
          )}
          {(a.kind === "setField" || a.kind === "clearField") && (
            <FieldPicker value={a.field} onChange={(field) => set(i, { ...a, field })} customFields={customFields} />
          )}
          {a.kind === "setField" && (
            <>
              <Pick
                label="Value kind"
                value={"now" in a.value ? "now" : "actor" in a.value ? "actor" : "literal"}
                onChange={(k) => set(i, { ...a, value: k === "now" ? { now: true } : k === "actor" ? { actor: true } : { literal: "" } })}
                options={[
                  { value: "literal", label: "to" },
                  { value: "now", label: "to now" },
                  { value: "actor", label: "to the person moving it" },
                ]}
              />
              {"literal" in a.value && (
                <Input aria-label="Value" className="h-8 w-40" value={String(a.value.literal ?? "")} onChange={(e) => set(i, { ...a, value: { literal: e.target.value } })} />
              )}
            </>
          )}
          {(a.kind === "addLabels" || a.kind === "removeLabels") && (
            <Input
              aria-label="Labels, separated by commas"
              className="h-8 w-56"
              value={a.labels.join(", ")}
              onChange={(e) => {
                const labels = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                if (labels.length > 0) set(i, { ...a, labels });
              }}
            />
          )}
          {a.kind === "addComment" && (
            <Input aria-label="Comment" className="h-8 w-64" value={a.body} onChange={(e) => e.target.value && set(i, { ...a, body: e.target.value })} />
          )}
          {a.kind === "addWatcher" && (
            <Pick
              label="Who"
              value={a.who}
              onChange={(who) => set(i, { ...a, who: who as "actor" | "assignee" })}
              options={[
                { value: "actor", label: "the person moving it" },
                { value: "assignee", label: "the assignee" },
              ]}
            />
          )}
          <RemoveButton label="Remove action" onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Pick
        label="Add an action"
        value=""
        placeholder="Add an action…"
        onChange={(k) => {
          const kind = ACTION_KINDS.find((x) => x.value === k);
          if (kind) onChange([...value, kind.make()]);
        }}
        options={ACTION_KINDS.map(({ value: v, label }) => ({ value: v, label }))}
        className="min-w-48"
      />
    </div>
  );
}
