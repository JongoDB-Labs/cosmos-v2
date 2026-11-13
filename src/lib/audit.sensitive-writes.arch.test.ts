// @vitest-environment node
//
// Money, pay and org-settings writes each leave an audit row: who did what,
// when, from where. The list below is those handlers and the action each one
// records; this holds each handler (its body and the route-local helpers it
// calls) to a logAudit call with that action. A new write of this kind joins
// the list. audit.sensitive-writes.db.test.ts drives a sample of them against
// a real database, so the rows are proved to land, not just written down.
//
// A handler may also audit through a library helper that owns the row (the
// feedback automation settings do, so the row is written in the same
// transaction as the change). Such an entry names the helper and its module:
// the handler must call the helper, and the helper must call logAudit with the
// action.
//
// Decisions are audited too. Deciding time off and bulk-approving expenses
// are listed. Approving one expense (finance/expenses/[expenseId]/approve) and
// deciding a timesheet (timesheets/[timesheetId]) also call logAudit, but
// build the action at run time, which this text check can't match, so they
// are not listed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { handlerCode } from "./auth/__tests__/gate-bits";

/** Audited through `via`, an exported function of `from` that writes the row. */
type ViaHelper = { via: string; from: string; action: string };

const AUDITED: Record<string, string | string[] | ViaHelper> = {
  "POST invoices": "invoice.created",
  "PUT invoices/[invoiceId]": "invoice.updated",
  "DELETE invoices/[invoiceId]": "invoice.deleted",
  "POST invoices/[invoiceId]/send": "invoice.sent",
  "POST invoices/[invoiceId]/void": "invoice.voided",
  "POST invoices/[invoiceId]/payments": "invoice.payment_recorded",
  "POST invoices/[invoiceId]/reimbursables": "invoice.reimbursables_added",
  "POST accounting/accounts": "gl_account.created",
  "POST accounting/backfill": "ledger.backfilled",
  "POST accounting/gl-import": "ledger.gl_imported",
  "POST accounting/journal-entries": "journal_entry.posted",
  "POST bank-accounts": "bank_account.created",
  "PUT bank-accounts/[bankAccountId]": "bank_account.updated",
  "POST bank-accounts/[bankAccountId]/import": "bank_account.imported",
  "POST bank-transactions/[txnId]/categorize": "bank_transaction.categorized",
  "POST bank-transactions/[txnId]/exclude": "bank_transaction.excluded",
  "POST bank-transactions/[txnId]/match": "bank_transaction.matched",
  "POST bank-rules": "bank_rule.created",
  "PATCH bank-rules/[ruleId]": "bank_rule.updated",
  "DELETE bank-rules/[ruleId]": "bank_rule.deleted",
  "POST bills": "bill.created",
  "PATCH bills/[billId]": "bill.updated",
  "POST tax-rates": "tax_rate.created",
  "PUT tax-rates/[taxRateId]": "tax_rate.updated",
  "DELETE tax-rates/[taxRateId]": "tax_rate.deleted",
  "POST pay-runs": "pay_run.created",
  "POST pay-runs/[payRunId]/post": "pay_run.posted",
  "POST employees": "employee.created",
  "PUT employees/[employeeId]": "employee.updated",
  "POST employees/bulk": "employee.bulk_created",
  "POST time-off": ["time_off.requested", "time_off.filed_for"],
  "PATCH time-off/[requestId]": ["time_off.decided", "time_off.withdrawn"],
  "POST finance/expenses/bulk-approve": "expense.bulk_approved",
  "POST projects/[projectId]/vendors": "vendor.created",
  "PATCH projects/[projectId]/vendors/[vendorId]": "vendor.updated",
  "DELETE projects/[projectId]/vendors/[vendorId]": "vendor.deleted",
  "POST contracts/[contractId]/signature": "contract.signature_requested",
  "PUT email-settings": "email_settings.updated",
  "PUT feedback/remediation-config": {
    via: "auditAutomationChange",
    from: "src/lib/feedback/automation-operator.server.ts",
    action: "feedback_automation.changed",
  },
  "PATCH theme": "theme.updated",
  "POST logo": "logo.uploaded",
  "DELETE logo": "logo.deleted",
};

const isVia = (rule: string | string[] | ViaHelper): rule is ViaHelper => typeof rule === "object" && !Array.isArray(rule);

/** An exported top-level function's text, by name. */
function exportedFunction(src: string, name: string): string | null {
  for (const m of src.matchAll(/^export (?:async )?function (\w+)\b[\s\S]*?\n\}/gm)) if (m[1] === name) return m[0];
  return null;
}

/** Whether `code` writes an audit row with `rule`'s action(s), directly or through its helper. */
function recordsAudit(code: string, rule: string | string[] | ViaHelper): boolean {
  if (isVia(rule)) {
    const helper = exportedFunction(readFileSync(rule.from, "utf8"), rule.via);
    return new RegExp(`\\b${rule.via}\\(`).test(code) && helper !== null
      && /\blogAudit\(/.test(helper) && helper.includes(`action: "${rule.action}"`);
  }
  return /\blogAudit\(/.test(code) && [rule].flat().every((a) => code.includes(`action: "${a}"`));
}

function codeOf(entry: string): string | null {
  const [method, path] = entry.split(" ");
  const file = `src/app/api/v1/orgs/[orgId]/${path}/route.ts`;
  return handlerCode(readFileSync(file, "utf8"), method, file);
}

/**
 * The finance writes above. Their rows carry no money: what happened, to which
 * record, and which fields changed by NAME, never an amount, rate or cost
 * (the audit log is read without any finance permission).
 */
const FINANCE = /^(?:POST|PUT|PATCH|DELETE) (?:invoices|accounting|bank-|bills|tax-rates|pay-runs|employees|projects\/\[projectId\]\/vendors)/;
const MONEY_KEY = /\b\w*(?:amount|rate|total|value|cost|price|balance|debit|credit|pay)\w*\s*:/i;

/** The object passed to each logAudit call in `code`. */
function auditArgs(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\blogAudit\(\{/g)) {
    let depth = 0;
    for (let i = m.index! + "logAudit(".length; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) { out.push(code.slice(m.index!, i + 1)); break; }
    }
  }
  return out;
}

describe("sensitive writes record an audit row", () => {
  const label = (rule: string | string[] | ViaHelper) => (isVia(rule) ? `${rule.action} via ${rule.via}` : [rule].flat().join(", "));
  it.each(Object.entries(AUDITED).map(([entry, rule]) => [entry, label(rule), rule] as const))("%s records %s", (entry, _label, rule) => {
    const code = codeOf(entry);
    expect(code, `${entry}: no such handler`).not.toBeNull();
    expect(recordsAudit(code!, rule)).toBe(true);
  });

  it.each(Object.keys(AUDITED).filter((e) => FINANCE.test(e)))("%s records no money in it", (entry) => {
    const args = auditArgs(codeOf(entry)!);
    expect(args.length).toBeGreaterThan(0);
    // The fixed keys every row has are not money.
    for (const a of args) expect(a.replace(/\b(?:orgId|userId|action|entity|entityId|ipAddress)\s*:/g, "")).not.toMatch(MONEY_KEY);
  });

  it("the money check would catch an amount (a positive control)", () => {
    const [arg] = auditArgs(`await logAudit({ orgId, action: "x", metadata: { amount: String(input.amount) } });`);
    expect(arg).toMatch(MONEY_KEY);
    const [ok] = auditArgs(`await logAudit({ orgId, action: "x", metadata: { changed: Object.keys(input) } });`);
    expect(ok).not.toMatch(MONEY_KEY);
  });

  it("the matcher would catch a handler that writes without one (a positive control)", () => {
    const silent = `export async function POST() {\n  await prisma.taxRate.create({});\n  return success({});\n}\n`;
    const loud = `export async function POST() {\n  await prisma.taxRate.create({});\n  await logAudit({ action: "tax_rate.created" });\n}\n`;
    expect(handlerCode(silent, "POST")).not.toMatch(/\blogAudit\(/);
    expect(handlerCode(loud, "POST")).toMatch(/\blogAudit\(/);
  });

  it("a helper entry needs the handler to call the helper (a positive control)", () => {
    const rule = AUDITED["PUT feedback/remediation-config"];
    const code = codeOf("PUT feedback/remediation-config")!;
    expect(recordsAudit(code, rule)).toBe(true);
    expect(recordsAudit(code.replace(/\bauditAutomationChange\(/g, "noAudit("), rule)).toBe(false);
    // And the helper must write the named action.
    expect(recordsAudit(code, { ...(rule as ViaHelper), action: "feedback_automation.renamed" })).toBe(false);
  });
});
