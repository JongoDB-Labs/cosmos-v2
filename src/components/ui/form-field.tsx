"use client";
import { useId } from "react";
import { Label } from "./label";
import { cn } from "@/lib/utils";

/** Props the field passes to its control so the label/error/required are wired
 * for assistive tech. Spread these onto the <Input>/<Textarea>/control. */
export interface FieldControlProps {
  id: string;
  "aria-invalid": true | undefined;
  "aria-describedby": string | undefined;
  "aria-required": true | undefined;
}

/**
 * Accessible form field: renders a <Label> bound to the control, a required
 * marker, and an inline error message — and wires `aria-invalid` +
 * `aria-describedby` (error/hint) + `aria-required` so screen readers announce
 * the requirement and the error against the field. The error <p> carries the
 * id the control's aria-describedby points at.
 *
 *   <FormField label="Name" required error={errors.name}>
 *     {(p) => <Input value={name} onChange={...} {...p} />}
 *   </FormField>
 */
export function FormField({
  label,
  required,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  className?: string;
  children: (control: FieldControlProps) => React.ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  // Only reference ids that are actually rendered: the hint <p> is suppressed
  // while an error shows (hint && !error), so don't point aria-describedby at it
  // then (a dangling id reference).
  const describedBy =
    [error ? errorId : null, hint && !error ? hintId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="text-[var(--status-critical-text,var(--status-critical))]" aria-hidden>
            *
          </span>
        )}
      </Label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
        "aria-required": required || undefined,
      })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
