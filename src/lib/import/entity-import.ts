/**
 * SERVER-ONLY engine for the GENERIC importer (every entity EXCEPT work items).
 *
 * The work-item importer keeps its own engine (src/lib/import/import-engine.ts);
 * this one handles the registry entities declared in entity-fields.ts. Flow:
 *
 *   request → apply the column mapping → tolerant coercion (per field kind) →
 *   validate required fields → idempotent CREATE-OR-UPDATE (upsert) keyed by the
 *   entity's natural key. Re-importing never duplicates: a row whose natural key
 *   already exists UPDATES that record with the mapped fields (a field that was
 *   omitted from the mapping, or blank, is left untouched — so importing one new
 *   column backfills only that column across the matched rows).
 *
 * "Tolerant" coercion: dates via a `new Date()` guard; ints/numbers parsed
 * leniently (strip $/commas); bools via /^(y|true|1)/i; enums matched
 * case/space-insensitively to the declared Prisma labels ("not started" →
 * NOT_STARTED). Unmappable enum values are reported as per-row errors rather
 * than silently coerced to a default.
 *
 * Errors are collected PER ROW — one bad row never aborts the whole import.
 */
import { Prisma } from "@prisma/client";
import type {
  DeliverableStatus,
  RiskStatus,
  RiskLevel,
  MilestoneStatus,
  ObjectiveStatus,
  GoalStatus,
  GoalProgressMode,
  CycleKind,
  SprintStatus,
  BlockerType,
  BlockerStatus,
  ChangeRequestStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { computeRiskScore, riskLevelFromScore } from "@/lib/pm/risk";
import {
  getEntityDef,
  IGNORE,
  type EntityDef,
  type EntityImportReport,
  type EntityImportRequest,
  type EntityImportRowError,
  type ImportField,
} from "./entity-fields";

export interface EntityEngineCtx {
  orgId: string;
  projectId: string;
  userId: string;
}

// ── Tolerant scalar coercion ────────────────────────────────────────────────

const cell = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? "" : String(v).trim();

/** Parse a date via a guarded `new Date()`; null when blank/unparseable. */
function coerceDate(raw: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Lenient number parse (strips $ , and spaces). null when blank/non-numeric. */
function coerceNumber(raw: string): number | null {
  if (!raw) return null;
  const v = raw.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Integer parse — rounds a numeric value; null when blank/non-numeric. */
function coerceInt(raw: string): number | null {
  const n = coerceNumber(raw);
  return n === null ? null : Math.round(n);
}

/** Truthy when the cell starts with y / true / 1 (case-insensitive). */
function coerceBool(raw: string): boolean {
  return /^(y|true|1)/i.test(raw);
}

/**
 * Match a raw cell to one of an enum's labels, case- AND separator-insensitive
 * ("not started", "Not-Started", "NOT_STARTED" → NOT_STARTED). Returns the
 * canonical label, or null when no label matches.
 */
function coerceEnum(raw: string, values: string[]): string | null {
  if (!raw) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const target = norm(raw);
  return values.find((v) => norm(v) === target) ?? null;
}

interface CoercedCell {
  value: unknown;
  /** Set when the cell was non-blank but couldn't be coerced (enum miss, etc.). */
  warning?: string;
}

/** Coerce one already-mapped cell per its field kind. */
function coerceField(field: ImportField, raw: string): CoercedCell {
  switch (field.kind) {
    case "text":
      return { value: raw || null };
    case "date": {
      if (!raw) return { value: null };
      const d = coerceDate(raw);
      return d ? { value: d } : { value: null, warning: `${field.label}: "${raw}" is not a valid date — left blank` };
    }
    case "number": {
      if (!raw) return { value: null };
      const n = coerceNumber(raw);
      return n !== null ? { value: n } : { value: null, warning: `${field.label}: "${raw}" is not a number — left blank` };
    }
    case "int": {
      if (!raw) return { value: null };
      const n = coerceInt(raw);
      return n !== null ? { value: n } : { value: null, warning: `${field.label}: "${raw}" is not a whole number — left blank` };
    }
    case "bool":
      return { value: raw ? coerceBool(raw) : null };
    case "enum": {
      if (!raw) return { value: null };
      const matched = coerceEnum(raw, field.enum ?? []);
      return matched
        ? { value: matched }
        : { value: null, warning: `${field.label}: "${raw}" is not a recognized value (${(field.enum ?? []).join(", ")}) — left blank` };
    }
    default:
      return { value: raw || null };
  }
}

// ── Per-row mapping → coerced field bag ──────────────────────────────────────

interface MappedRow {
  rowNum: number;
  /** fieldKey → coerced value (only fields that mapped to a present column). */
  fields: Record<string, unknown>;
  warnings: string[];
  /** Blocking error (missing required field, etc.) — routes the row to skipped. */
  error: string | null;
}

/** First source header chosen for each fieldKey (first mapping wins). */
function headerForField(mapping: Record<string, string>): Record<string, string> {
  const first: Record<string, string> = {};
  for (const [header, fieldKey] of Object.entries(mapping)) {
    if (!fieldKey || fieldKey === IGNORE) continue;
    if (first[fieldKey] === undefined) first[fieldKey] = header;
  }
  return first;
}

function mapRows(def: EntityDef, req: EntityImportRequest): MappedRow[] {
  const headerOf = headerForField(req.mapping);

  return req.rows.map((row, i) => {
    const rowNum = i + 1;
    const fields: Record<string, unknown> = {};
    const warnings: string[] = [];

    for (const f of def.fields) {
      const header = headerOf[f.key];
      if (header === undefined) continue; // column not mapped
      const raw = cell(row[header]);
      const { value, warning } = coerceField(f, raw);
      fields[f.key] = value;
      if (warning) warnings.push(warning);
    }

    // Required-field validation (a coerced-to-null required field is missing).
    const missing = def.fields
      .filter((f) => f.required)
      .filter((f) => {
        const v = fields[f.key];
        return v === undefined || v === null || v === "";
      })
      .map((f) => f.label);

    const error = missing.length ? `Missing required: ${missing.join(", ")}` : null;
    return { rowNum, fields, warnings, error };
  });
}

// ── Natural-key helpers (create-or-update / upsert) ──────────────────────────

/** Build a stable string token from a row's natural-key field values. */
function naturalKeyToken(def: EntityDef, fields: Record<string, unknown>): string {
  // `vendor` coalesces agmtNumber → title; everything else joins its key parts.
  if (def.key === "vendor") {
    const agmt = (fields.agmtNumber as string | null) || "";
    const title = (fields.title as string | null) || "";
    return (agmt || title).toLowerCase();
  }
  return def.naturalKey
    .map((k) => String(fields[k] ?? "").toLowerCase())
    .join(" ");
}

/**
 * Load a map of natural-key token → existing row id for this org/project, so a
 * re-imported row can UPDATE its existing record (idempotent upsert) instead of
 * creating a duplicate. One scoped query per entity. (For `vendor` the id is the
 * Contract id.)
 */
async function loadExistingIds(
  def: EntityDef,
  ctx: EntityEngineCtx,
): Promise<Map<string, string>> {
  const { orgId, projectId } = ctx;
  const tokenize = (fields: Record<string, unknown>) => naturalKeyToken(def, fields);
  const toMap = (rows: Array<{ id: string } & Record<string, unknown>>, keyFields: (r: Record<string, unknown>) => Record<string, unknown>) =>
    new Map(rows.map((r) => [tokenize(keyFields(r)), r.id] as const));

  switch (def.key) {
    case "deliverable": {
      const rows = await prisma.deliverable.findMany({ where: { orgId, projectId }, select: { id: true, code: true } });
      return toMap(rows, (r) => ({ code: r.code }));
    }
    case "risk": {
      const rows = await prisma.risk.findMany({ where: { orgId, projectId }, select: { id: true, code: true } });
      return toMap(rows, (r) => ({ code: r.code }));
    }
    case "milestone": {
      const rows = await prisma.milestone.findMany({ where: { orgId, projectId }, select: { id: true, title: true } });
      return toMap(rows, (r) => ({ title: r.title }));
    }
    case "clin": {
      const rows = await prisma.clin.findMany({ where: { orgId, projectId }, select: { id: true, code: true } });
      return toMap(rows, (r) => ({ code: r.code }));
    }
    case "objective": {
      const rows = await prisma.objective.findMany({ where: { orgId, projectId }, select: { id: true, title: true } });
      return toMap(rows, (r) => ({ title: r.title }));
    }
    case "goal": {
      const rows = await prisma.goal.findMany({ where: { orgId, projectId }, select: { id: true, title: true } });
      return toMap(rows, (r) => ({ title: r.title }));
    }
    case "cycle": {
      const rows = await prisma.cycle.findMany({ where: { projectId }, select: { id: true, name: true } });
      return toMap(rows, (r) => ({ name: r.name }));
    }
    case "blocker": {
      const rows = await prisma.blocker.findMany({ where: { orgId, projectId }, select: { id: true, code: true } });
      return toMap(rows, (r) => ({ code: r.code }));
    }
    case "changeRequest": {
      const rows = await prisma.changeRequest.findMany({ where: { orgId, projectId }, select: { id: true, code: true } });
      return toMap(rows, (r) => ({ code: r.code }));
    }
    case "vendor": {
      const rows = await prisma.contract.findMany({
        where: { orgId, projectId },
        select: { id: true, agmtNumber: true, title: true },
      });
      return toMap(rows, (r) => ({ agmtNumber: r.agmtNumber, title: r.title }));
    }
    default:
      return new Map();
  }
}

/**
 * Extra per-row blocking validation beyond the registry's `required` flags:
 * code-keyed entities must carry a non-blank code (it anchors idempotency, and
 * we never auto-generate one).
 */
function codeKeyError(def: EntityDef, fields: Record<string, unknown>): string | null {
  if (def.naturalKey.includes("code")) {
    const code = fields.code;
    if (code === undefined || code === null || code === "") {
      return "Missing code (required — anchors idempotent import; never auto-generated)";
    }
  }
  return null;
}

// ── Per-entity CREATE (commit). Returns nothing; throws on failure (caught per
//    row by the caller). `cycle` consumes a per-project number counter; `vendor`
//    find-or-creates the Partner then creates the Contract. ──

interface CommitState {
  /** Next cycle.number for this project (lazily seeded on first cycle row). */
  nextCycleNumber: number | null;
  /** Partner name (lowercased) → Partner id cache for vendor imports. */
  partnerCache: Map<string, string>;
}

const s = (fields: Record<string, unknown>, key: string): string | null =>
  (fields[key] as string | null) ?? null;
const dt = (fields: Record<string, unknown>, key: string): Date | null =>
  (fields[key] as Date | null) ?? null;
const n = (fields: Record<string, unknown>, key: string): number | null =>
  (fields[key] as number | null) ?? null;
const b = (fields: Record<string, unknown>, key: string): boolean =>
  (fields[key] as boolean | null) ?? false;

async function createEntityRow(
  def: EntityDef,
  ctx: EntityEngineCtx,
  fields: Record<string, unknown>,
  state: CommitState,
): Promise<void> {
  const { orgId, projectId } = ctx;

  switch (def.key) {
    case "deliverable": {
      await prisma.deliverable.create({
        data: {
          orgId, projectId,
          code: s(fields, "code")!,
          title: s(fields, "title")!,
          description: s(fields, "description"),
          clin: s(fields, "clin"),
          deliverableType: s(fields, "deliverableType"),
          status: (s(fields, "status") as DeliverableStatus | null) ?? undefined,
          baselineDue: dt(fields, "baselineDue"),
          internalReview: dt(fields, "internalReview"),
          actualSubmission: dt(fields, "actualSubmission"),
          govReviewPeriod: n(fields, "govReviewPeriod"),
          govAcceptance: dt(fields, "govAcceptance"),
          owner: s(fields, "owner"),
          branchOwner: s(fields, "branchOwner"),
          revisionCycle: n(fields, "revisionCycle") ?? undefined,
          revRequired: b(fields, "revRequired"),
          escalate: b(fields, "escalate"),
          workItemRef: s(fields, "workItemRef"),
          notes: s(fields, "notes"),
        },
      });
      return;
    }
    case "risk": {
      const likelihood = n(fields, "likelihood") ?? 1;
      const impact = n(fields, "impact") ?? 1;
      const score = computeRiskScore(likelihood, impact);
      const level = riskLevelFromScore(score);
      await prisma.risk.create({
        data: {
          orgId, projectId,
          code: s(fields, "code")!,
          title: s(fields, "title")!,
          description: s(fields, "description"),
          category: s(fields, "category"),
          likelihood, impact, score,
          level: level as RiskLevel,
          owner: s(fields, "owner"),
          mitigation: s(fields, "mitigation"),
          contingency: s(fields, "contingency"),
          status: (s(fields, "status") as RiskStatus | null) ?? undefined,
          trend: s(fields, "trend"),
          targetDate: dt(fields, "targetDate"),
        },
      });
      return;
    }
    case "milestone": {
      await prisma.milestone.create({
        data: {
          orgId, projectId,
          title: s(fields, "title")!,
          description: s(fields, "description"),
          dueDate: dt(fields, "dueDate")!,
          phase: s(fields, "phase"),
          status: (s(fields, "status") as MilestoneStatus | null) ?? undefined,
          notes: s(fields, "notes"),
          autoStatus: false,
        },
      });
      return;
    }
    case "clin": {
      await prisma.clin.create({
        data: {
          orgId, projectId,
          code: s(fields, "code")!,
          title: s(fields, "title")!,
          value: numericOrUndefined(n(fields, "value")),
          fundedValue: numericOrUndefined(n(fields, "fundedValue")),
          popStart: dt(fields, "popStart"),
          popEnd: dt(fields, "popEnd"),
          status: s(fields, "status") ?? undefined,
        },
      });
      return;
    }
    case "objective": {
      await prisma.objective.create({
        data: {
          orgId, projectId,
          title: s(fields, "title")!,
          description: s(fields, "description"),
          period: s(fields, "period"),
          status: (s(fields, "status") as ObjectiveStatus | null) ?? undefined,
          progress: 0,
        },
      });
      return;
    }
    case "goal": {
      await prisma.goal.create({
        data: {
          orgId, projectId,
          title: s(fields, "title")!,
          description: s(fields, "description"),
          status: (s(fields, "status") as GoalStatus | null) ?? undefined,
          targetDate: dt(fields, "targetDate"),
          progressMode: (s(fields, "progressMode") as GoalProgressMode | null) ?? undefined,
        },
      });
      return;
    }
    case "cycle": {
      if (state.nextCycleNumber === null) {
        const max = await prisma.cycle.aggregate({ where: { projectId }, _max: { number: true } });
        state.nextCycleNumber = (max._max.number ?? 0) + 1;
      }
      const number = state.nextCycleNumber++;
      await prisma.cycle.create({
        data: {
          orgId, projectId, number,
          name: s(fields, "name")!,
          goal: s(fields, "goal") ?? undefined,
          startDate: dt(fields, "startDate")!,
          endDate: dt(fields, "endDate")!,
          cycleKind: (s(fields, "cycleKind") as CycleKind | null) ?? undefined,
          status: (s(fields, "status") as SprintStatus | null) ?? undefined,
        },
      });
      return;
    }
    case "blocker": {
      await prisma.blocker.create({
        data: {
          orgId, projectId,
          code: s(fields, "code")!,
          title: s(fields, "title")!,
          description: s(fields, "description"),
          type: (s(fields, "type") as BlockerType | null) ?? undefined,
          status: (s(fields, "status") as BlockerStatus | null) ?? undefined,
          whatUnblocks: s(fields, "whatUnblocks"),
          owner: s(fields, "owner"),
          source: s(fields, "source"),
          targetDate: dt(fields, "targetDate"),
          notes: s(fields, "notes"),
        },
      });
      return;
    }
    case "changeRequest": {
      await prisma.changeRequest.create({
        data: {
          orgId, projectId,
          code: s(fields, "code")!,
          title: s(fields, "title")!,
          description: s(fields, "description"),
          type: s(fields, "type"),
          status: (s(fields, "status") as ChangeRequestStatus | null) ?? undefined,
          initiatedBy: s(fields, "initiatedBy"),
          costImpact: numericOrUndefined(n(fields, "costImpact")),
          scheduleDaysImpact: n(fields, "scheduleDaysImpact"),
          notes: s(fields, "notes"),
        },
      });
      return;
    }
    case "vendor": {
      const partnerName = s(fields, "partnerName")!;
      const cacheKey = partnerName.toLowerCase();
      let partnerId = state.partnerCache.get(cacheKey);
      if (!partnerId) {
        const existing = await prisma.partner.findFirst({
          where: { orgId, name: { equals: partnerName, mode: "insensitive" } },
          select: { id: true },
        });
        partnerId = existing
          ? existing.id
          : (await prisma.partner.create({
              data: { orgId, name: partnerName, type: "vendor" },
              select: { id: true },
            })).id;
        state.partnerCache.set(cacheKey, partnerId);
      }
      await prisma.contract.create({
        data: {
          orgId, projectId, partnerId,
          title: s(fields, "title")!,
          value: numericOrUndefined(n(fields, "value")),
          fundedValue: numericOrUndefined(n(fields, "fundedValue")),
          agmtType: s(fields, "agmtType"),
          agmtNumber: s(fields, "agmtNumber"),
          status: s(fields, "status") ?? "active",
          startDate: dt(fields, "startDate"),
          endDate: dt(fields, "endDate"),
        },
      });
      return;
    }
    default:
      throw new Error(`Unsupported entity: ${def.key}`);
  }
}

/** Decimal columns accept a JS number or Prisma.Decimal; undefined keeps the default. */
function numericOrUndefined(v: number | null): Prisma.Decimal | undefined {
  return v === null ? undefined : new Prisma.Decimal(v);
}

// ── Per-entity UPDATE (idempotent upsert of an existing row) ──────────────────
// A re-imported row updates ONLY the columns present in this import (blanks and
// unmapped columns never clobber existing data), so adding a new column to a
// spreadsheet and re-importing simply backfills that one field.

const dec = (v: unknown) => new Prisma.Decimal(v as number);

/** Build a partial patch: a column is included only when its field was mapped
 *  AND coerced to a non-null value. `entries` are [fieldKey, column, transform?]. */
function patch(
  fields: Record<string, unknown>,
  entries: Array<[string, string, ((v: unknown) => unknown)?]>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [fk, col, tf] of entries) {
    if (fk in fields) {
      const v = fields[fk];
      if (v !== null && v !== undefined) data[col] = tf ? tf(v) : v;
    }
  }
  return data;
}

async function updateEntityRow(
  def: EntityDef,
  ctx: EntityEngineCtx,
  id: string,
  fields: Record<string, unknown>,
  state: CommitState,
): Promise<void> {
  const { orgId } = ctx;
  switch (def.key) {
    case "deliverable": {
      const data = patch(fields, [
        ["title", "title"], ["description", "description"], ["clin", "clin"],
        ["deliverableType", "deliverableType"], ["status", "status"],
        ["baselineDue", "baselineDue"], ["internalReview", "internalReview"],
        ["actualSubmission", "actualSubmission"], ["govReviewPeriod", "govReviewPeriod"],
        ["govAcceptance", "govAcceptance"], ["owner", "owner"], ["branchOwner", "branchOwner"],
        ["revisionCycle", "revisionCycle"], ["revRequired", "revRequired"], ["escalate", "escalate"],
        ["workItemRef", "workItemRef"], ["notes", "notes"],
      ]);
      if (Object.keys(data).length) await prisma.deliverable.update({ where: { id }, data });
      return;
    }
    case "risk": {
      const data = patch(fields, [
        ["title", "title"], ["description", "description"], ["category", "category"],
        ["owner", "owner"], ["mitigation", "mitigation"], ["contingency", "contingency"],
        ["status", "status"], ["trend", "trend"], ["targetDate", "targetDate"],
      ]);
      const hasL = fields.likelihood != null;
      const hasI = fields.impact != null;
      if (hasL || hasI) {
        const cur = await prisma.risk.findUnique({ where: { id }, select: { likelihood: true, impact: true } });
        const likelihood = hasL ? (fields.likelihood as number) : (cur?.likelihood ?? 1);
        const impact = hasI ? (fields.impact as number) : (cur?.impact ?? 1);
        const score = computeRiskScore(likelihood, impact);
        Object.assign(data, { likelihood, impact, score, level: riskLevelFromScore(score) as RiskLevel });
      }
      if (Object.keys(data).length) await prisma.risk.update({ where: { id }, data });
      return;
    }
    case "milestone": {
      const data = patch(fields, [
        ["title", "title"], ["description", "description"], ["dueDate", "dueDate"],
        ["phase", "phase"], ["status", "status"], ["notes", "notes"],
      ]);
      if (Object.keys(data).length) await prisma.milestone.update({ where: { id }, data });
      return;
    }
    case "clin": {
      const data = patch(fields, [
        ["title", "title"], ["value", "value", dec], ["fundedValue", "fundedValue", dec],
        ["popStart", "popStart"], ["popEnd", "popEnd"], ["status", "status"],
      ]);
      if (Object.keys(data).length) await prisma.clin.update({ where: { id }, data });
      return;
    }
    case "objective": {
      const data = patch(fields, [
        ["title", "title"], ["description", "description"], ["period", "period"], ["status", "status"],
      ]);
      if (Object.keys(data).length) await prisma.objective.update({ where: { id }, data });
      return;
    }
    case "goal": {
      const data = patch(fields, [
        ["title", "title"], ["description", "description"], ["status", "status"],
        ["targetDate", "targetDate"], ["progressMode", "progressMode"],
      ]);
      if (Object.keys(data).length) await prisma.goal.update({ where: { id }, data });
      return;
    }
    case "cycle": {
      // number stays fixed (identity); update the rest.
      const data = patch(fields, [
        ["name", "name"], ["goal", "goal"], ["startDate", "startDate"],
        ["endDate", "endDate"], ["cycleKind", "cycleKind"], ["status", "status"],
      ]);
      if (Object.keys(data).length) await prisma.cycle.update({ where: { id }, data });
      return;
    }
    case "blocker": {
      const data = patch(fields, [
        ["title", "title"], ["description", "description"], ["type", "type"], ["status", "status"],
        ["whatUnblocks", "whatUnblocks"], ["owner", "owner"], ["source", "source"],
        ["targetDate", "targetDate"], ["notes", "notes"],
      ]);
      if (Object.keys(data).length) await prisma.blocker.update({ where: { id }, data });
      return;
    }
    case "changeRequest": {
      const data = patch(fields, [
        ["title", "title"], ["description", "description"], ["type", "type"], ["status", "status"],
        ["initiatedBy", "initiatedBy"], ["costImpact", "costImpact", dec],
        ["scheduleDaysImpact", "scheduleDaysImpact"], ["notes", "notes"],
      ]);
      if (Object.keys(data).length) await prisma.changeRequest.update({ where: { id }, data });
      return;
    }
    case "vendor": {
      const data = patch(fields, [
        ["title", "title"], ["value", "value", dec], ["fundedValue", "fundedValue", dec],
        ["agmtType", "agmtType"], ["agmtNumber", "agmtNumber"], ["status", "status"],
        ["startDate", "startDate"], ["endDate", "endDate"],
      ]);
      // Re-point to a (possibly new) partner when a partner name is provided.
      if (fields.partnerName != null) {
        const partnerName = fields.partnerName as string;
        const cacheKey = partnerName.toLowerCase();
        let partnerId = state.partnerCache.get(cacheKey);
        if (!partnerId) {
          const existing = await prisma.partner.findFirst({
            where: { orgId, name: { equals: partnerName, mode: "insensitive" } },
            select: { id: true },
          });
          partnerId = existing
            ? existing.id
            : (await prisma.partner.create({ data: { orgId, name: partnerName, type: "vendor" }, select: { id: true } })).id;
          state.partnerCache.set(cacheKey, partnerId);
        }
        data.partnerId = partnerId;
      }
      if (Object.keys(data).length) await prisma.contract.update({ where: { id }, data });
      return;
    }
    default:
      throw new Error(`Unsupported entity: ${def.key}`);
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function runEntityImport(
  ctx: EntityEngineCtx,
  req: EntityImportRequest,
): Promise<EntityImportReport> {
  const def = getEntityDef(req.entity);
  if (!def) {
    return { total: req.rows.length, willCreate: 0, willUpdate: 0, skipped: req.rows.length, errors: [{ row: 0, message: `Unknown entity "${req.entity}"` }] };
  }

  const mapped = mapRows(def, req);
  const errors: EntityImportRowError[] = [];

  // Per-row blocking validation (required fields + code presence). Warnings
  // (bad enum/date values) are surfaced too, but don't block the row.
  for (const m of mapped) {
    const err = m.error ?? codeKeyError(def, m.fields);
    if (err) m.error = err;
    for (const w of m.warnings) errors.push({ row: m.rowNum, message: w });
  }

  // Natural key → existing row id. A row whose key already exists is UPDATED
  // (idempotent upsert) instead of skipped; a brand-new key is created.
  const existingIds = await loadExistingIds(def, ctx);
  const seen = new Set<string>(); // tokens claimed within THIS batch (dedup the file)

  let willCreate = 0;
  let willUpdate = 0;
  let skipped = 0;
  const creates: MappedRow[] = [];
  const updates: Array<{ m: MappedRow; id: string }> = [];
  for (const m of mapped) {
    if (m.error) {
      errors.push({ row: m.rowNum, message: m.error });
      skipped++;
      continue;
    }
    const token = naturalKeyToken(def, m.fields);
    if (seen.has(token)) {
      skipped++; // same key twice in one file → first wins, later rows skipped
      continue;
    }
    seen.add(token);
    const existingId = existingIds.get(token);
    if (existingId) {
      willUpdate++;
      updates.push({ m, id: existingId });
    } else {
      willCreate++;
      creates.push(m);
    }
  }

  // Stable ordering: blocking errors won't be drowned by warnings in the cap.
  errors.sort((a, x) => a.row - x.row);

  const report: EntityImportReport = {
    total: mapped.length,
    willCreate,
    willUpdate,
    skipped,
    errors: errors.slice(0, 200),
  };

  if (req.mode === "validate") return report;

  // ── commit ──
  const state: CommitState = { nextCycleNumber: null, partnerCache: new Map() };
  let created = 0;
  let updated = 0;
  const commitErrors: EntityImportRowError[] = [];
  for (const m of creates) {
    try {
      await createEntityRow(def, ctx, m.fields, state);
      created++;
    } catch (e) {
      commitErrors.push({ row: m.rowNum, message: e instanceof Error ? e.message : "Failed to import row" });
    }
  }
  for (const { m, id } of updates) {
    try {
      await updateEntityRow(def, ctx, id, m.fields, state);
      updated++;
    } catch (e) {
      commitErrors.push({ row: m.rowNum, message: e instanceof Error ? e.message : "Failed to update row" });
    }
  }

  report.created = created;
  report.updated = updated;
  if (commitErrors.length) {
    report.errors = [...report.errors, ...commitErrors].slice(0, 200);
    report.skipped += commitErrors.length;
    report.willCreate = created;
    report.willUpdate = updated;
  }
  return report;
}
