"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SYSTEM_FIELDS, type FieldRef } from "@/lib/workflow/definition";
import { cn } from "@/lib/utils";

/** A labelled single choice; `value` "" shows the placeholder. */
export function Pick({
  value,
  onChange,
  options,
  label,
  placeholder = "Choose…",
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select value={value || null} onValueChange={(v) => v && onChange(String(v))} disabled={disabled}>
      <SelectTrigger aria-label={label} size="sm" className={cn("min-w-32", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export const SYSTEM_FIELD_LABELS: Record<(typeof SYSTEM_FIELDS)[number], string> = {
  assigneeId: "Assignee",
  priority: "Priority",
  storyPoints: "Story points",
  dueDate: "Due date",
  startDate: "Start date",
  intervalId: "Sprint",
  teamId: "Team",
  description: "Description",
  resolution: "Resolution",
  workCategory: "Work category",
  labels: "Labels",
  cancelReason: "Cancel reason",
  cancelNote: "Cancel note",
};

export const fieldKey = (f: FieldRef): string => ("custom" in f ? `custom:${f.custom}` : `system:${f.system}`);

export function parseFieldKey(key: string): FieldRef | null {
  const [kind, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "system" && (SYSTEM_FIELDS as readonly string[]).includes(name)) return { system: name as (typeof SYSTEM_FIELDS)[number] };
  if (kind === "custom" && name) return { custom: name };
  return null;
}

export function fieldLabel(f: FieldRef, custom: { key: string; name: string }[]): string {
  return "custom" in f ? (custom.find((c) => c.key === f.custom)?.name ?? f.custom) : SYSTEM_FIELD_LABELS[f.system];
}

/** A field: one of the system fields, or a custom field by key. */
export function FieldPicker({
  value,
  onChange,
  customFields,
  label = "Field",
}: {
  value: FieldRef | null;
  onChange: (f: FieldRef) => void;
  customFields: { key: string; name: string }[];
  label?: string;
}) {
  const options = [
    ...SYSTEM_FIELDS.map((f) => ({ value: `system:${f}`, label: SYSTEM_FIELD_LABELS[f] })),
    ...customFields.map((c) => ({ value: `custom:${c.key}`, label: c.name })),
  ];
  return (
    <Pick
      label={label}
      value={value ? fieldKey(value) : ""}
      onChange={(k) => {
        const f = parseFieldKey(k);
        if (f) onChange(f);
      }}
      options={options}
      placeholder="Field…"
    />
  );
}
