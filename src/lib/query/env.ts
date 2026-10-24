/**
 * What a query's functions and variables mean at the moment it runs: the
 * bridge between the DB-backed resolver and the pure compiler. Kept apart from
 * compile.ts so that only execute.server.ts imports the compiler (arch test).
 */
import type { CqlValue, FieldRef } from "./ast";
import type { CustomFieldType } from "./typecheck";
import { stableStringify } from "./normalize";

export type StatusCategory = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";

export interface CompileEnv {
  actorUserId: string;
  now: Date;
  tz: string;
  /** Set-valued functions expanded to ids, keyed by `fnKey(fn)`. */
  fnIds: Map<string, string[]>;
  /** Variable values, already resolved for the field they are used with; null = unset (inert). */
  vars: Map<string, CqlValue[] | null>;
  /** Readable projects' column keys per category. */
  statusCategories: Record<StatusCategory, { projectId: string; keys: string[] }[]>;
  /** Items referenced by key comparisons (`key > ACME-100`). */
  items: Map<string, { projectId: string; ticketNumber: number }>;
  /** Custom field types by key. */
  customFields: Map<string, CustomFieldType>;
  contextProjectId?: string;
  sinceLastStandup?: Date;
}

export function fnKey(v: Extract<CqlValue, { t: "fn" }>): string {
  return stableStringify({ name: v.name, args: v.args });
}

export function varKey(name: string, field: FieldRef): string {
  return `${name}@${field.kind === "sys" ? field.id : `cf:${field.key}`}`;
}

