import type { AuthContext } from "./check";
import { financeScope, scopeCovers } from "./finance-scope";

/**
 * Money on the program registers, and who may see it.
 *
 * A CLIN's ceiling and funding, its burn (labour cost is approved hours times a
 * person's cost rate), a change request's cost impact and a vendor contract's
 * values are finance data. They used to ride on ANALYTICS_READ, which every
 * VIEWER holds, so a read-only member could see what a contract is worth --
 * and, on a CLIN one person charges, divide labour cost by hours and read off
 * that person's cost rate.
 *
 * The rule, everywhere these fields leave the server (list and get routes,
 * write responses, change history, EVM, the Excel and SharePoint exports, the
 * assistant's tools and the server-rendered pages): FINANCE_READ, or
 * FINANCE_READ_PROJECT on a project the reader is a member of. That is
 * `financeScope` + `scopeCovers`; this module is the one place a register
 * asks it and the one place that knows which fields are money.
 *
 * Without it the RECORD still arrives, with its money fields left out -- not
 * zeroed, because a zero is a figure and reads as one. A screen tells "not
 * yours to see" from "nothing on file" by the field being absent.
 *
 * Anything new that returns these records -- a dashboard widget, an export, a
 * tool -- goes through this module, not its own copy of the rule:
 *
 *   const gate = await moneyGate(ctx);              // once per request
 *   projectMoney("vendor", row, gate(row.projectId)) // one record
 *   projectMoneyEach("vendor", rows, gate)          // records on mixed projects
 *   projectMoneyRows("clin", rows, gate(projectId)) // records on one project
 */
export const MONEY_FIELDS = {
  /** A CLIN, raw or with burn (`loadClinsWithBurn`). */
  clin: ["value", "fundedValue", "laborCost", "expenseCost", "burned", "remaining", "percentConsumed"],
  /** A change request. Its SCHEDULE impact is program information, not money. */
  change: ["costImpact"],
  /** A vendor-register row (`mapVendorContract`), or a raw Contract anywhere (CRM, exports). */
  vendor: ["value", "fundedValue", "invoicedValue", "remainingFunded", "pctBurnedFunded"],
} as const;

export type MoneyKind = keyof typeof MONEY_FIELDS;
type MoneyField<K extends MoneyKind> = (typeof MONEY_FIELDS)[K][number];

/**
 * Sets, not the tuples: membership is checked at runtime against arbitrary
 * keys, and `.includes` over a literal union is a known tsc heap hazard here.
 */
const MONEY_SETS: Record<MoneyKind, ReadonlySet<string>> = {
  clin: new Set(MONEY_FIELDS.clin),
  change: new Set(MONEY_FIELDS.change),
  vendor: new Set(MONEY_FIELDS.vendor),
};

/** Is `field` a money field of this kind of record? */
export function isMoneyField(kind: MoneyKind, field: string | null | undefined): boolean {
  return !!field && MONEY_SETS[kind].has(field);
}

/** Answers "may this reader see money on this project?" for many projects at one cost. */
export type MoneyGate = (projectId: string | null | undefined) => boolean;

/**
 * The reader's money gate. Resolve once per request and ask it per project:
 * it hits the database only for the project-limited grant.
 *
 * A record with no project is covered only by the org-wide grant, because
 * membership of "no project" cannot be confirmed.
 */
export async function moneyGate(ctx: AuthContext): Promise<MoneyGate> {
  const scope = await financeScope(ctx);
  return (projectId) => scopeCovers(scope, projectId);
}

/** May this reader see money on this one project? */
export async function canSeeProjectMoney(ctx: AuthContext, projectId: string): Promise<boolean> {
  return (await moneyGate(ctx))(projectId);
}

/** One record with its money fields left out. */
export function withoutMoney<K extends MoneyKind, T extends object>(kind: K, row: T): Omit<T, MoneyField<K>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!MONEY_SETS[kind].has(k)) out[k] = v;
  return out as Omit<T, MoneyField<K>>;
}

/** One record, as this reader may see it. */
export function projectMoney<K extends MoneyKind, T extends object>(
  kind: K,
  row: T,
  allowed: boolean,
): T | Omit<T, MoneyField<K>> {
  return allowed ? row : withoutMoney(kind, row);
}

/** Many records, all on projects `allowed` was decided for. */
export function projectMoneyRows<K extends MoneyKind, T extends object>(
  kind: K,
  rows: T[],
  allowed: boolean,
): Array<T | Omit<T, MoneyField<K>>> {
  return allowed ? rows : rows.map((r) => withoutMoney(kind, r));
}

/**
 * Many records on mixed projects, each decided by its own `projectId`: the CRM
 * contract list, a partner's or a product's contracts, an org export. A record
 * with no project needs the org-wide grant (see `moneyGate`).
 */
export function projectMoneyEach<K extends MoneyKind, T extends { projectId?: string | null }>(
  kind: K,
  rows: T[],
  gate: MoneyGate,
): Array<T | Omit<T, MoneyField<K>>> {
  return rows.map((r) => projectMoney(kind, r, gate(r.projectId)));
}

/**
 * A register's change history, as this reader may see it. A change to a money
 * field still shows that the field changed -- who and when are not money --
 * but not from what to what.
 */
export function projectMoneyActivity<T extends { field?: string | null; oldValue?: unknown; newValue?: unknown }>(
  kind: MoneyKind,
  rows: T[],
  allowed: boolean,
): Array<T | Omit<T, "oldValue" | "newValue">> {
  if (allowed) return rows;
  return rows.map((r) => {
    if (!isMoneyField(kind, r.field)) return r;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { oldValue, newValue, ...rest } = r;
    return rest;
  });
}
