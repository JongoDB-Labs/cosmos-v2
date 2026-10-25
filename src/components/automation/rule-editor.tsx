"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Pick } from "@/components/workflow/fields";
import { AUTOMATION_LIMITS, CATEGORIES, WATCHABLE_FIELDS, automationSpecSchema, type AutomationAction, type AutomationSpec } from "@/lib/automation/spec";
import { CATEGORY_LABELS, FIELD_LABELS } from "@/lib/automation/describe";
import { TEMPLATE_NAMES } from "@/lib/automation/template";
import { CANCEL_REASONS } from "@/lib/work-items/cancel";
import type { RuleIssue } from "./api";

export interface StatusChoice {
  key: string;
  name: string;
  category: (typeof CATEGORIES)[number];
}

export interface RuleChoices {
  statuses: StatusChoice[];
  members: { userId: string; displayName: string }[];
  teams: { id: string; name: string }[];
  intervals: { id: string; name: string }[];
  /** Null when the person can't see the org's webhooks. */
  webhooks: { id: string; url: string }[] | null;
}

export interface RuleDraft {
  name: string;
  spec: AutomationSpec;
  allowChain: boolean;
}

type Trigger = AutomationSpec["trigger"];
type Kind = AutomationAction["kind"];

const TRIGGERS: { value: Trigger["on"]; label: string; make: () => Trigger }[] = [
  { value: "item.created", label: "An item is created", make: () => ({ on: "item.created" }) },
  { value: "item.updated", label: "An item changes", make: () => ({ on: "item.updated" }) },
  { value: "item.transitioned", label: "An item moves status", make: () => ({ on: "item.transitioned" }) },
  { value: "schedule", label: "On a schedule", make: () => ({ on: "schedule", every: "day", hour: 9, minute: 0, cql: "statusCategory IN (TODO, IN_PROGRESS)" }) },
];

const ACTIONS: { value: Kind; label: string; make: (c: RuleChoices) => AutomationAction }[] = [
  { value: "transition", label: "Move to a status", make: (c) => ({ kind: "transition", to: c.statuses[0]?.key ?? "" }) },
  { value: "setField", label: "Set a field", make: () => ({ kind: "setField", field: "priority", value: "HIGH" }) },
  { value: "assign", label: "Assign", make: () => ({ kind: "assign", to: "triggerActor" }) },
  { value: "addLabels", label: "Add labels", make: () => ({ kind: "addLabels", labels: ["label"] }) },
  { value: "removeLabels", label: "Remove labels", make: () => ({ kind: "removeLabels", labels: ["label"] }) },
  { value: "addComment", label: "Comment", make: () => ({ kind: "addComment", body: "{{rule.name}} ran on {{item.key}}." }) },
  { value: "notify", label: "Notify", make: () => ({ kind: "notify", to: "assignee", message: "{{item.key}} {{item.title}}" }) },
  { value: "webhook", label: "Send a webhook", make: (c) => ({ kind: "webhook", webhookId: c.webhooks?.[0]?.id ?? "" }) },
  { value: "archive", label: "Archive", make: () => ({ kind: "archive" }) },
];

const SET_FIELDS = [
  { value: "priority", label: "Priority" },
  { value: "storyPoints", label: "Story points" },
  { value: "teamId", label: "Team" },
  { value: "intervalId", label: "Sprint" },
  { value: "dueDate", label: "Due date" },
  { value: "startDate", label: "Start date" },
] as const;

const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const NONE = "__none__";

const blankRule = (): RuleDraft => ({
  name: "",
  spec: { trigger: { on: "item.transitioned", toCategory: ["DONE"] }, scope: "trigger", actions: [{ kind: "addComment", body: "{{item.key}} is done." }], options: { includeImports: false } },
  allowChain: false,
});

/** The rule builder: WHEN a trigger fires, IF the item matches, THEN the actions. Checked with the server's own schema before it's sent. */
export function RuleEditor({
  open,
  onOpenChange,
  initial,
  title,
  choices,
  saving,
  serverIssues,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null for a new, blank rule. */
  initial: RuleDraft | null;
  title: string;
  choices: RuleChoices;
  saving: boolean;
  serverIssues: RuleIssue[];
  onSave: (draft: RuleDraft) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {open && <RuleForm initial={initial ?? blankRule()} title={title} choices={choices} saving={saving} serverIssues={serverIssues} onSave={onSave} onCancel={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  );
}

function RuleForm({
  initial,
  title,
  choices,
  saving,
  serverIssues,
  onSave,
  onCancel,
}: {
  initial: RuleDraft;
  title: string;
  choices: RuleChoices;
  saving: boolean;
  serverIssues: RuleIssue[];
  onSave: (draft: RuleDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [shown, setShown] = useState<RuleIssue[]>([]);
  const spec = draft.spec;
  const setSpec = (patch: Partial<AutomationSpec>) => setDraft((d) => ({ ...d, spec: { ...d.spec, ...patch } }));
  const scheduled = spec.trigger.on === "schedule";
  const statusOpts = choices.statuses.map((s) => ({ value: s.key, label: s.name }));
  const issues = [...shown, ...serverIssues];

  const save = () => {
    const name = draft.name.trim();
    const parsed = automationSpecSchema.safeParse(spec);
    const found: RuleIssue[] = [];
    if (!name) found.push({ path: "name", message: "Give the rule a name." });
    if (!parsed.success) for (const i of parsed.error.issues) found.push({ path: i.path.join("."), message: i.message });
    setShown(found);
    if (found.length === 0 && parsed.success) onSave({ ...draft, name, spec: parsed.data });
  };

  const setTrigger = (on: Trigger["on"]) => {
    const trigger = TRIGGERS.find((t) => t.value === on)!.make();
    // A schedule acts on what its query finds: no condition, no scope, no "who made the change".
    if (on === "schedule") setSpec({ trigger, condition: undefined, scope: "trigger", actions: spec.actions.map((a) => (a.kind === "assign" && a.to === "triggerActor" ? { ...a, to: "unassigned" } : a)) });
    else setSpec({ trigger });
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <SheetHeader>
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>
          Runs with your access as the rule&apos;s owner, through the project&apos;s workflow: it can&apos;t do anything you couldn&apos;t, and the change log names Cosmos Automation.
        </SheetDescription>
      </SheetHeader>

      <div className="grid gap-5 px-4 text-sm">
        <label className="grid gap-1">
          <span>Name</span>
          <Input aria-label="Rule name" value={draft.name} maxLength={120} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
        </label>

        <Section title="When">
          <Pick label="Trigger" value={spec.trigger.on} onChange={(v) => setTrigger(v as Trigger["on"])} options={TRIGGERS} />
          <TriggerFields trigger={spec.trigger} statusOpts={statusOpts} onChange={(trigger) => setSpec({ trigger })} />
        </Section>

        {!scheduled && (
          <Section title="If" hint="Leave both empty to act on every item the trigger fires for.">
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">It matches this query (CQL)</span>
              <Textarea
                aria-label="Condition query"
                rows={2}
                value={spec.condition?.cql ?? ""}
                maxLength={AUTOMATION_LIMITS.cqlLength}
                placeholder="priority = HIGH AND assignee IS EMPTY"
                onChange={(e) => setSpec({ condition: condition(e.target.value || undefined, spec.condition?.childrenAll) })}
              />
            </label>
            <div className="grid gap-1">
              <label className="flex items-center gap-2">
                <Checkbox
                  aria-label="Only when every child is settled"
                  checked={!!spec.condition?.childrenAll}
                  onChange={(e) => setSpec({ condition: condition(spec.condition?.cql, e.target.checked ? { categories: ["DONE", "CANCELLED"] } : undefined) })}
                />
                Every one of its children is in
              </label>
              {spec.condition?.childrenAll && (
                <SearchableMultiSelect
                  aria-label="Children's categories"
                  size="sm"
                  className="ml-6 min-w-56"
                  value={spec.condition.childrenAll.categories}
                  options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
                  onValueChange={(v) => setSpec({ condition: condition(spec.condition?.cql, { categories: v as (typeof CATEGORIES)[number][] }) })}
                />
              )}
            </div>
          </Section>
        )}

        {!scheduled && (
          <Section title="Act on">
            <Pick
              label="Act on"
              value={spec.scope}
              onChange={(v) => setSpec({ scope: v as AutomationSpec["scope"] })}
              options={[
                { value: "trigger", label: "The item itself" },
                { value: "parent", label: "Its parent" },
                { value: "children", label: `Its children (up to ${AUTOMATION_LIMITS.scopedItems})` },
              ]}
            />
          </Section>
        )}

        <Section title="Then" hint={`Up to ${AUTOMATION_LIMITS.actions} actions, in order. Comments and notifications can use ${TEMPLATE_NAMES.map((n) => `{{${n}}}`).join(", ")}.`}>
          <ol className="grid gap-3">
            {spec.actions.map((a, i) => (
              <li key={i} className="grid gap-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Pick
                    label={`Action ${i + 1}`}
                    value={a.kind}
                    onChange={(k) => setSpec({ actions: spec.actions.map((x, j) => (j === i ? ACTIONS.find((o) => o.value === k)!.make(choices) : x)) })}
                    options={ACTIONS}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove action ${i + 1}`}
                    disabled={spec.actions.length === 1}
                    onClick={() => setSpec({ actions: spec.actions.filter((_, j) => j !== i) })}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <ActionFields
                  action={a}
                  index={i}
                  choices={choices}
                  scheduled={scheduled}
                  onChange={(next) => setSpec({ actions: spec.actions.map((x, j) => (j === i ? next : x)) })}
                />
              </li>
            ))}
          </ol>
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            disabled={spec.actions.length >= AUTOMATION_LIMITS.actions}
            onClick={() => setSpec({ actions: [...spec.actions, ACTIONS[0].make(choices)] })}
          >
            <Plus className="size-4" /> Add an action
          </Button>
        </Section>

        <Section title="Options">
          <label className="flex items-center gap-2">
            <Checkbox checked={spec.options.includeImports} onChange={(e) => setSpec({ options: { includeImports: e.target.checked } })} />
            Also run on changes an import makes
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={draft.allowChain} onChange={(e) => setDraft((d) => ({ ...d, allowChain: e.target.checked }))} />
            Let other automations&apos; changes fire this rule
          </label>
        </Section>

        {issues.length > 0 && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="font-medium">The rule can&apos;t be saved yet</p>
            <ul className="mt-1 list-disc pl-5 text-xs">
              {issues.map((x, i) => (
                <li key={i}>{x.message}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <SheetFooter className="mt-auto flex-row justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving}>
          Save rule
        </Button>
      </SheetFooter>
    </div>
  );
}

function condition(cql: string | undefined, childrenAll: { categories: (typeof CATEGORIES)[number][] } | undefined): AutomationSpec["condition"] {
  return cql || childrenAll ? { ...(cql && { cql }), ...(childrenAll && { childrenAll }) } : undefined;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </fieldset>
  );
}

function TriggerFields({ trigger, statusOpts, onChange }: { trigger: Trigger; statusOpts: { value: string; label: string }[]; onChange: (t: Trigger) => void }) {
  if (trigger.on === "item.updated") {
    return (
      <SearchableMultiSelect
        aria-label="Fields that changed"
        placeholder="Any field"
        size="sm"
        className="min-w-56"
        value={trigger.fields ?? []}
        options={WATCHABLE_FIELDS.map((f) => ({ value: f, label: FIELD_LABELS[f] ?? f }))}
        onValueChange={(v) => onChange({ on: "item.updated", ...(v.length && { fields: v as (typeof WATCHABLE_FIELDS)[number][] }) })}
      />
    );
  }
  if (trigger.on === "item.transitioned") {
    const set = (patch: Partial<typeof trigger>) => {
      const next = { ...trigger, ...patch };
      for (const k of ["from", "to", "toCategory"] as const) if (!next[k]?.length) delete next[k];
      onChange(next);
    };
    return (
      <div className="grid gap-2 sm:grid-cols-3">
        <MultiField label="From" placeholder="Any status" value={trigger.from ?? []} options={statusOpts} onChange={(from) => set({ from })} />
        <MultiField label="To" placeholder="Any status" value={trigger.to ?? []} options={statusOpts} onChange={(to) => set({ to })} />
        <MultiField
          label="Or to any status in"
          placeholder="Any category"
          value={trigger.toCategory ?? []}
          options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          onChange={(v) => set({ toCategory: v as (typeof CATEGORIES)[number][] })}
        />
      </div>
    );
  }
  if (trigger.on === "schedule") {
    const num = (v: string, max: number) => Math.max(0, Math.min(max, Math.trunc(Number(v) || 0)));
    return (
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Pick
            label="How often"
            value={trigger.every}
            onChange={(every) => onChange({ ...trigger, every: every as typeof trigger.every })}
            options={[
              { value: "hour", label: "Every hour" },
              { value: "day", label: "Every day" },
              { value: "week", label: "Every Monday" },
            ]}
          />
          {trigger.every !== "hour" && (
            <label className="flex items-center gap-1">
              at
              <Input aria-label="Hour (UTC)" type="number" min={0} max={23} className="w-16" value={trigger.hour} onChange={(e) => onChange({ ...trigger, hour: num(e.target.value, 23) })} />
            </label>
          )}
          <label className="flex items-center gap-1">
            {trigger.every === "hour" ? "at minute" : ":"}
            <Input aria-label="Minute" type="number" min={0} max={59} className="w-16" value={trigger.minute} onChange={(e) => onChange({ ...trigger, minute: num(e.target.value, 59) })} />
          </label>
          <span className="text-xs text-muted-foreground">UTC</span>
        </div>
        <label className="grid gap-1">
          <span className="text-xs text-muted-foreground">Acts on the items this query (CQL) finds, up to {AUTOMATION_LIMITS.scheduledItems} a run</span>
          <Textarea aria-label="Schedule query" rows={2} maxLength={AUTOMATION_LIMITS.cqlLength} value={trigger.cql} onChange={(e) => onChange({ ...trigger, cql: e.target.value })} />
        </label>
      </div>
    );
  }
  return null;
}

function MultiField({
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string[];
  options: { value: string; label: string }[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <SearchableMultiSelect aria-label={label} placeholder={placeholder} size="sm" value={value} options={options} onValueChange={onChange} />
    </div>
  );
}

function ActionFields({
  action: a,
  index,
  choices,
  scheduled,
  onChange,
}: {
  action: AutomationAction;
  index: number;
  choices: RuleChoices;
  scheduled: boolean;
  onChange: (a: AutomationAction) => void;
}) {
  const n = index + 1;
  switch (a.kind) {
    case "transition": {
      const cancelling = choices.statuses.find((s) => s.key === a.to)?.category === "CANCELLED";
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Pick label={`Action ${n} status`} value={a.to} onChange={(to) => onChange({ kind: "transition", to })} options={choices.statuses.map((s) => ({ value: s.key, label: s.name }))} />
          {cancelling && (
            <>
              <Pick
                label={`Action ${n} cancel reason`}
                value={a.cancel?.reason ?? NONE}
                onChange={(r) => onChange({ kind: "transition", to: a.to, ...(r !== NONE && { cancel: { reason: r as "OBE" | "OTHER", ...(a.cancel?.note && { note: a.cancel.note }) } }) })}
                options={[{ value: NONE, label: "No reason" }, ...CANCEL_REASONS.map((r) => ({ value: r.value, label: r.label }))]}
              />
              {a.cancel?.reason === "OTHER" && (
                <Input aria-label={`Action ${n} cancel note`} placeholder="Why" className="min-w-48 flex-1" value={a.cancel.note ?? ""} onChange={(e) => onChange({ ...a, cancel: { reason: "OTHER", note: e.target.value } })} />
              )}
            </>
          )}
        </div>
      );
    }
    case "setField":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Pick
            label={`Action ${n} field`}
            value={a.field}
            onChange={(f) => onChange(defaultSet(f as (typeof SET_FIELDS)[number]["value"]))}
            options={[...SET_FIELDS]}
          />
          <SetValue action={a} n={n} choices={choices} onChange={onChange} />
        </div>
      );
    case "assign": {
      const value = typeof a.to === "object" ? a.to.userId : a.to;
      return (
        <Pick
          label={`Action ${n} assignee`}
          value={value}
          onChange={(v) => onChange({ kind: "assign", to: v === "triggerActor" || v === "unassigned" ? v : { userId: v } })}
          options={[
            ...(scheduled ? [] : [{ value: "triggerActor", label: "Whoever made the change" }]),
            { value: "unassigned", label: "Nobody (unassign)" },
            ...choices.members.map((m) => ({ value: m.userId, label: m.displayName })),
          ]}
        />
      );
    }
    case "addLabels":
    case "removeLabels":
      return (
        <Input
          aria-label={`Action ${n} labels`}
          placeholder="Comma-separated"
          defaultValue={a.labels.join(", ")}
          onChange={(e) => onChange({ kind: a.kind, labels: e.target.value.split(",").map((l) => l.trim()).filter(Boolean) })}
        />
      );
    case "addComment":
      return <Textarea aria-label={`Action ${n} comment`} rows={2} maxLength={AUTOMATION_LIMITS.templateLength} value={a.body} onChange={(e) => onChange({ kind: "addComment", body: e.target.value })} />;
    case "notify": {
      const to = typeof a.to === "object" ? "people" : a.to;
      return (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Pick
              label={`Action ${n} recipients`}
              value={to}
              onChange={(v) => onChange({ ...a, to: v === "people" ? { userIds: choices.members.slice(0, 1).map((m) => m.userId) } : (v as "assignee" | "creator" | "triggerActor") })}
              options={[
                { value: "assignee", label: "The assignee" },
                { value: "creator", label: "Who created it" },
                ...(scheduled ? [] : [{ value: "triggerActor", label: "Whoever made the change" }]),
                { value: "people", label: "These people" },
              ]}
            />
            {typeof a.to === "object" && (
              <SearchableMultiSelect
                aria-label={`Action ${n} people`}
                size="sm"
                className="min-w-56"
                value={a.to.userIds}
                options={choices.members.map((m) => ({ value: m.userId, label: m.displayName }))}
                onValueChange={(userIds) => onChange({ ...a, to: { userIds } })}
              />
            )}
          </div>
          <Textarea aria-label={`Action ${n} message`} rows={2} maxLength={AUTOMATION_LIMITS.templateLength} value={a.message} onChange={(e) => onChange({ ...a, message: e.target.value })} />
        </div>
      );
    }
    case "webhook":
      return choices.webhooks === null ? (
        <p className="text-xs text-muted-foreground">You can&apos;t see the organization&apos;s webhooks: someone who manages webhooks can set this action up.</p>
      ) : choices.webhooks.length === 0 ? (
        <p className="text-xs text-muted-foreground">There are no webhooks yet. Add one in Settings → Webhooks.</p>
      ) : (
        <Pick label={`Action ${n} webhook`} value={a.webhookId} onChange={(webhookId) => onChange({ kind: "webhook", webhookId })} options={choices.webhooks.map((w) => ({ value: w.id, label: w.url }))} />
      );
    case "archive":
      return null;
  }
}

function defaultSet(field: (typeof SET_FIELDS)[number]["value"]): AutomationAction {
  switch (field) {
    case "priority":
      return { kind: "setField", field, value: "HIGH" };
    case "storyPoints":
      return { kind: "setField", field, value: 1 };
    case "teamId":
    case "intervalId":
      return { kind: "setField", field, value: null };
    case "dueDate":
    case "startDate":
      return { kind: "setField", field, value: { daysFromNow: 7 } };
  }
}

function SetValue({ action: a, n, choices, onChange }: { action: Extract<AutomationAction, { kind: "setField" }>; n: number; choices: RuleChoices; onChange: (a: AutomationAction) => void }) {
  const label = `Action ${n} value`;
  switch (a.field) {
    case "priority":
      return <Pick label={label} value={a.value} onChange={(v) => onChange({ ...a, value: v as (typeof PRIORITIES)[number] })} options={PRIORITIES.map((p) => ({ value: p, label: p[0] + p.slice(1).toLowerCase() }))} />;
    case "storyPoints":
      return (
        <Input
          aria-label={label}
          type="number"
          min={0}
          max={1000}
          placeholder="Empty clears it"
          className="w-32"
          value={a.value ?? ""}
          onChange={(e) => onChange({ ...a, value: e.target.value === "" ? null : Math.max(0, Math.min(1000, Math.trunc(Number(e.target.value)))) })}
        />
      );
    case "teamId":
    case "intervalId": {
      const opts = (a.field === "teamId" ? choices.teams : choices.intervals).map((x) => ({ value: x.id, label: x.name }));
      return <Pick label={label} value={a.value ?? NONE} onChange={(v) => onChange({ ...a, value: v === NONE ? null : v })} options={[{ value: NONE, label: a.field === "teamId" ? "No team" : "No sprint" }, ...opts]} />;
    }
    case "dueDate":
    case "startDate":
      return (
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2">
            <Checkbox checked={a.value === null} onChange={(e) => onChange({ ...a, value: e.target.checked ? null : { daysFromNow: 7 } })} />
            Clear it
          </label>
          {a.value !== null && (
            <label className="flex items-center gap-1">
              <Input
                aria-label={label}
                type="number"
                min={-3650}
                max={3650}
                className="w-20"
                value={a.value.daysFromNow}
                onChange={(e) => onChange({ ...a, value: { daysFromNow: Math.max(-3650, Math.min(3650, Math.trunc(Number(e.target.value) || 0))) } })}
              />
              days from the run
            </label>
          )}
        </div>
      );
  }
}
