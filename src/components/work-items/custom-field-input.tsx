"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { CustomField } from "@/types/models";

/** Sentinel for "no selection" in a single SELECT — base-ui Selects can't hold
 *  an empty-string value distinct from unset, so we map it to/from "". */
const SELECT_NONE = "__none__";

/** Coerce an unknown stored value to a display string (TEXT/URL/EMAIL/NUMBER). */
function asString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Coerce an unknown stored value to a string[] (MULTI_SELECT). */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value) return [value];
  return [];
}

export interface CustomFieldInputProps {
  field: CustomField;
  value: unknown;
  /** Called with the new value (string | number | boolean | string[] | null). */
  onChange: (value: unknown) => void;
  disabled?: boolean;
  /** Render a red asterisk + an aria-required hint when the field is required. */
  showRequiredMark?: boolean;
  /** Mark the control invalid (e.g. required but empty on submit). */
  invalid?: boolean;
}

/**
 * Renders the editor for a single custom-field definition, dispatched by
 * `fieldType`. Pure presentation — the caller owns the value and persists it
 * (POST body on create, per-field PUT on the detail sheet). The USER field
 * type is intentionally NOT rendered yet (no shared member picker plumbed in
 * here); the caller skips it.
 */
export function CustomFieldInput({
  field,
  value,
  onChange,
  disabled,
  showRequiredMark,
  invalid,
}: CustomFieldInputProps) {
  const labelId = `cf-${field.id}`;
  const invalidCls = invalid ? "border-destructive ring-1 ring-destructive/40" : "";

  let control: React.ReactNode;

  switch (field.fieldType) {
    case "NUMBER":
      control = (
        <Input
          id={labelId}
          type="number"
          value={asString(value)}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
          disabled={disabled}
          className={cn("h-9", invalidCls)}
        />
      );
      break;

    case "DATE":
      control = (
        <DatePicker
          value={asString(value)}
          onValueChange={(v) => onChange(v || null)}
          className={cn("h-9", invalidCls)}
        />
      );
      break;

    case "CHECKBOX":
      control = (
        <div className="flex h-9 items-center">
          <Checkbox
            id={labelId}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
          />
        </div>
      );
      break;

    case "SELECT": {
      const current = asString(value);
      control = (
        <Select
          items={{
            [SELECT_NONE]: "—",
            ...Object.fromEntries(field.options.map((o) => [o, o])),
          }}
          value={current || SELECT_NONE}
          onValueChange={(v) => onChange(v && v !== SELECT_NONE ? v : null)}
          disabled={disabled}
        >
          <SelectTrigger
            size="sm"
            aria-labelledby={labelId}
            className={cn("w-full text-xs", invalidCls)}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SELECT_NONE}>—</SelectItem>
            {field.options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
      break;
    }

    case "MULTI_SELECT": {
      const selected = asStringArray(value);
      control = (
        <div className={cn("flex flex-wrap gap-1.5", invalid && "rounded-md p-1 ring-1 ring-destructive/40")}>
          {field.options.length === 0 ? (
            <span className="text-xs text-muted-foreground">No options defined</span>
          ) : (
            field.options.map((o) => {
              const active = selected.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  onClick={() =>
                    onChange(
                      active ? selected.filter((s) => s !== o) : [...selected, o],
                    )
                  }
                  className={cn(
                    "rounded-md px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50",
                    active
                      ? "bg-primary/20 text-primary"
                      : "bg-muted/50 text-muted-foreground hover:bg-muted",
                  )}
                >
                  {o}
                </button>
              );
            })
          )}
        </div>
      );
      break;
    }

    // TEXT / URL / EMAIL all render a text input (typed for nicer mobile UX).
    case "URL":
    case "EMAIL":
    case "TEXT":
    default:
      control = (
        <Input
          id={labelId}
          type={field.fieldType === "URL" ? "url" : field.fieldType === "EMAIL" ? "email" : "text"}
          value={asString(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          disabled={disabled}
          className={cn("h-9", invalidCls)}
        />
      );
      break;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label id={labelId} htmlFor={labelId} className="text-xs">
        {field.name}
        {showRequiredMark && field.required && (
          <span className="ml-0.5 text-destructive" aria-hidden>
            *
          </span>
        )}
      </Label>
      {control}
    </div>
  );
}

/**
 * True when a required field has no usable value (used to block submit /
 * highlight the control). Mirrors the empty-cases each control can produce.
 */
export function isCustomFieldEmpty(field: CustomField, value: unknown): boolean {
  switch (field.fieldType) {
    case "CHECKBOX":
      // A required checkbox must be checked (an explicit acknowledgement).
      return value !== true;
    case "MULTI_SELECT":
      return asStringArray(value).length === 0;
    default:
      return asString(value).trim() === "";
  }
}

/** Field types we render an editor for. USER is deferred (no member picker). */
export function isRenderableCustomField(field: CustomField): boolean {
  return field.fieldType !== "USER";
}
