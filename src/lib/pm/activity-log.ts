import { prisma } from "@/lib/db/client";
import type { PmSubjectType } from "./subjects";

/**
 * Append an Activity row for a PM subject (polymorphic). Best-effort — never
 * throws into the caller's request path. Use for "created"/"commented" events
 * and for field-change diffs from a register PATCH.
 */
export async function logPmActivity(opts: {
  orgId: string;
  subjectType: PmSubjectType;
  subjectId: string;
  userId: string;
  action: string; // "created" | "commented" | "updated" | …
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
}): Promise<void> {
  try {
    await prisma.activity.create({
      data: {
        orgId: opts.orgId,
        subjectType: opts.subjectType,
        subjectId: opts.subjectId,
        userId: opts.userId,
        action: opts.action,
        field: opts.field ?? null,
        oldValue: opts.oldValue ?? null,
        newValue: opts.newValue ?? null,
      },
    });
  } catch {
    /* swallow — activity logging is best-effort */
  }
}

/** Stringify a value for the activity diff columns. */
export function actVal(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * Diff two field maps and log one "updated" Activity per changed field. Pass the
 * subset of fields you want audited (label-keyed). Best-effort.
 */
export async function logPmFieldChanges(
  base: {
    orgId: string;
    subjectType: PmSubjectType;
    subjectId: string;
    userId: string;
  },
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  for (const field of Object.keys(after)) {
    const oldV = actVal(before[field]);
    const newV = actVal(after[field]);
    if (oldV !== newV) {
      await logPmActivity({ ...base, action: "updated", field, oldValue: oldV, newValue: newV });
    }
  }
}
