"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CustomFieldInput, isCustomFieldEmpty } from "@/components/work-items/custom-field-input";
import { cn } from "@/lib/utils";
import { CANCEL_NOTE_MAX, CANCEL_REASONS, cancelInputError, type PickableCancelReason } from "@/lib/work-items/cancel";
import { fieldKey } from "@/lib/workflow/actions";
import type { TransitionInputField } from "@/lib/workflow/contract";
import type { CustomField } from "@/types/models";

/** Values keyed by `fieldKey` ("system:resolution", "custom:root_cause"). */
export type TransitionInput = Record<string, unknown>;

export interface TransitionDialogProps {
  open: boolean;
  /** The transition being taken, as the server named it. */
  transition: { id: string; name: string } | null;
  fields: readonly TransitionInputField[];
  /** Custom-field definitions, so a custom input renders its own editor. */
  customFields?: readonly CustomField[];
  /** Values to start from (the item's current ones, or a reason being edited). */
  initial?: TransitionInput;
  pending: boolean;
  onSubmit: (input: TransitionInput) => void;
  onClose: () => void;
  title?: string;
  description?: string;
  submitLabel?: string;
  closeLabel?: string;
}

const SYSTEM_LABELS: Record<string, string> = {
  assigneeId: "Assignee",
  priority: "Priority",
  storyPoints: "Story points",
  dueDate: "Due date",
  startDate: "Start date",
  intervalId: "Interval",
  teamId: "Team",
  description: "Description",
  resolution: "Resolution",
  workCategory: "Work category",
  labels: "Labels",
  cancelReason: "Reason",
  cancelNote: "Note",
};

const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * The one dialog for "this status change needs more from you": a transition's
 * requested input (a resolution, a root cause, a cancel reason) or the fields
 * a validator found missing. It replaces the bespoke cancel-reason dialog; the
 * Cancel transition's input renders the same choices and labels.
 *
 * The caller opens it with the `fields` from a `transition_input_required`
 * refusal (or from the transition list), and retries the change with
 * `transition: { id, input }` on submit.
 */
export function TransitionDialog(props: TransitionDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={(next) => !next && props.onClose()}>
      {/* Keyed on open so each opening starts from `initial`. */}
      {props.open && props.transition && <TransitionForm {...props} transition={props.transition} />}
    </Dialog>
  );
}

function TransitionForm({
  transition,
  fields,
  customFields = [],
  initial = {},
  pending,
  onSubmit,
  onClose,
  title,
  description,
  submitLabel,
  closeLabel,
}: TransitionDialogProps & { transition: { id: string; name: string } }) {
  const [values, setValues] = useState<TransitionInput>(() => {
    const start: TransitionInput = { ...initial };
    // A cancel needs a reason picked; OBE is the self-explanatory default.
    if (fields.some((f) => "system" in f.field && f.field.system === "cancelReason") && !start["system:cancelReason"]) {
      start["system:cancelReason"] = "OBE";
    }
    return start;
  });
  const set = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

  const customByKey = new Map(customFields.map((f) => [f.key, f]));
  const reason = values["system:cancelReason"] as PickableCancelReason | undefined;
  const missing = fields.filter((f) => {
    if (!f.required) return false;
    const value = values[fieldKey(f.field)];
    if ("custom" in f.field) {
      const def = customByKey.get(f.field.custom);
      return def ? isCustomFieldEmpty(def, value) : empty(value);
    }
    return empty(value);
  });
  const cancelError = reason ? cancelInputError(reason, values["system:cancelNote"] as string | undefined) : null;
  const blocked = missing.length > 0 || Boolean(cancelError);

  return (
    <DialogContent onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <DialogHeader>
        <DialogTitle>{title ?? transition.name}</DialogTitle>
        <DialogDescription>{description ?? "This step needs a few details before it can go ahead."}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        {fields.map((f) => (
          <FieldEditor
            key={fieldKey(f.field)}
            input={f}
            value={values[fieldKey(f.field)]}
            onChange={(v) => set(fieldKey(f.field), v)}
            custom={"custom" in f.field ? customByKey.get(f.field.custom) : undefined}
            disabled={pending}
            reason={reason}
          />
        ))}
        {reason === "OTHER" && cancelError && <p className="text-xs text-muted-foreground">{cancelError}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={pending}>
          {closeLabel ?? "Cancel"}
        </Button>
        <Button
          onClick={() =>
            onSubmit(
              Object.fromEntries(
                Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
              ),
            )
          }
          disabled={pending || blocked}
        >
          {pending ? "Saving…" : (submitLabel ?? transition.name)}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function FieldEditor({
  input,
  value,
  onChange,
  custom,
  disabled,
  reason,
}: {
  input: TransitionInputField;
  value: unknown;
  onChange: (value: unknown) => void;
  custom?: CustomField;
  disabled: boolean;
  reason?: PickableCancelReason;
}) {
  const id = useId();
  const field = input.field;
  if ("custom" in field && custom) {
    return (
      <CustomFieldInput field={custom} value={value} onChange={onChange} disabled={disabled} showRequiredMark={input.required} />
    );
  }
  // A custom field whose definition the caller didn't load (the board) still
  // gets an editor: the server sent its label and, for a choice, its options.
  const label = input.label ?? ("custom" in field ? field.custom : (SYSTEM_LABELS[field.system] ?? field.system));
  const system = "system" in field ? field.system : null;

  if (system === "cancelReason") {
    return (
      <div role="radiogroup" aria-label={label} className="space-y-2">
        {CANCEL_REASONS.map((r) => (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={value === r.value}
            onClick={() => onChange(r.value)}
            disabled={disabled}
            className={cn(
              "w-full rounded-md border px-3 py-2 text-left text-sm",
              value === r.value ? "border-primary bg-muted" : "border-border hover:bg-muted",
            )}
          >
            <span className="font-medium">{r.label}</span>
            <span className="block text-xs text-muted-foreground">{r.hint}</span>
          </button>
        ))}
      </div>
    );
  }

  const required = input.required || (system === "cancelNote" && reason === "OTHER");
  const labelEl = (
    <label htmlFor={id} className="text-xs font-medium">
      {label}
      {required ? " *" : " (optional)"}
    </label>
  );

  let control: React.ReactNode;
  if (input.options && input.options.length > 0) {
    control = (
      <Select
        items={Object.fromEntries(input.options.map((o) => [o.value, o.label]))}
        value={typeof value === "string" ? value : null}
        onValueChange={(v) => onChange(v)}
        disabled={disabled}
      >
        <SelectTrigger id={id} size="sm" className="w-full text-xs" aria-required={required}>
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {input.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (system === "dueDate" || system === "startDate") {
    control = (
      <DatePicker
        value={typeof value === "string" ? value : undefined}
        onValueChange={(v) => onChange(v ? new Date(`${v.slice(0, 10)}T12:00:00.000Z`).toISOString() : null)}
        disabled={disabled}
        aria-label={label}
      />
    );
  } else if (system === "storyPoints") {
    control = (
      <Input
        id={id}
        type="number"
        min={0}
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        disabled={disabled}
        aria-required={required}
      />
    );
  } else if (system === "cancelNote" || system === "description") {
    control = (
      <Textarea
        id={id}
        value={typeof value === "string" ? value : ""}
        maxLength={system === "cancelNote" ? CANCEL_NOTE_MAX : undefined}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          system !== "cancelNote"
            ? undefined
            : reason === "OTHER"
              ? "Why was it cancelled?"
              : "e.g. Replaced by the new onboarding flow"
        }
        disabled={disabled}
        aria-required={required}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-required={required}
      />
    );
  }

  return (
    <div className="space-y-1">
      {labelEl}
      {control}
    </div>
  );
}
