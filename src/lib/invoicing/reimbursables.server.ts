import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { ConflictError, NotFoundError } from "@/lib/rbac/check";
import { financeSettings, resolveMarkup, markedUp, type MarkupSource, type ReimbursableLines } from "@/lib/finance/markup";
import { rebillLines, type RebillCost, type RebillKind, type RebillSource } from "@/lib/finance/rebill";
import { invoiceTotals, lineAmount } from "./totals";

/**
 * Re-billing a project's reimbursable costs on its client invoice.
 *
 * A reimbursable cost is a bill on the project (OPEN or PAID: a DRAFT bill is
 * not yet owed, a VOID one never will be) or an APPROVED expense marked
 * reimbursable. It is UNBILLED while no invoice has recovered it: its
 * invoiceId is null, or names an invoice that was voided (which recovered
 * nothing).
 *
 * "Add reimbursables" stamps each cost with the invoice and adds its lines in
 * one transaction. The stamp is claimed with a conditional update, so two
 * invoices adding the same cost at once can't both win: the loser's
 * transaction rolls back, lines and all. The cost keeps its exact amount;
 * only the line carries the markup.
 */

type Db = Prisma.TransactionClient | typeof prisma;

const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);

/** Not recovered by any invoice: never stamped, or stamped by one since voided. */
const UNBILLED = { OR: [{ invoiceId: null }, { invoice: { status: "VOID" as const } }] };

/** Which projects a read covers: one, or every project the caller can see (visibleProjectRecordsWhere). */
type Scope = { projectId?: string; visible?: { OR?: ({ projectId: null } | { projectId: { notIn: string[] } })[] } };

const scoped = (s: Scope) => ({
  projectId: s.projectId ?? { not: null },
  ...(s.visible?.OR ? { AND: [s.visible] } : {}),
});

const BILLABLE_BILL = (orgId: string, s: Scope): Prisma.BillWhereInput => ({
  orgId,
  status: { in: ["OPEN", "PAID"] },
  ...UNBILLED,
  ...scoped(s),
});

const BILLABLE_EXPENSE = (orgId: string, s: Scope): Prisma.ExpenseWhereInput => ({
  orgId,
  reimbursable: true,
  status: "APPROVED",
  ...UNBILLED,
  ...scoped(s),
});

export interface UnbilledReimbursable {
  source: RebillSource;
  id: string;
  label: string;
  date: string | null;
  cost: number;
  markup: { pct: number; source: MarkupSource };
  markupAmount: number;
  total: number;
}

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const billLabel = (b: { vendorName: string; reference: string }) => `${b.vendorName} — ${b.reference}`;
const expenseLabel = (e: { vendor: string | null; category: string; description: string }) =>
  [e.vendor || e.category, e.description.trim()].filter(Boolean).join(" — ");

/**
 * The unbilled reimbursable costs in scope, oldest first (bills, then
 * expenses), each priced at the markup that applies to it, with the project
 * it belongs to; and the org's line preference.
 */
async function collectUnbilled(
  db: Db,
  orgId: string,
  scope: Scope,
): Promise<{ items: (UnbilledReimbursable & { projectId: string })[]; lines: ReimbursableLines }> {
  const [org, bills, expenses] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId }, select: { settings: true } }),
    db.bill.findMany({
      where: BILLABLE_BILL(orgId, scope),
      select: { id: true, projectId: true, vendorName: true, reference: true, amount: true, markupPct: true, issueDate: true, createdAt: true },
      orderBy: [{ issueDate: "asc" }, { createdAt: "asc" }],
    }),
    db.expense.findMany({
      where: BILLABLE_EXPENSE(orgId, scope),
      select: { id: true, projectId: true, vendor: true, category: true, description: true, amount: true, date: true },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  const projectIds = [...new Set([...bills, ...expenses].map((c) => c.projectId!))];
  const terms = projectIds.length
    ? await db.projectFeeTerms.findMany({ where: { projectId: { in: projectIds } }, select: { projectId: true, markupPct: true } })
    : [];
  const projectPct = new Map(terms.map((t) => [t.projectId, t.markupPct]));
  const settings = financeSettings(org?.settings);
  const item = (source: RebillSource, id: string, projectId: string, label: string, date: Date | null, amount: Prisma.Decimal, own: Prisma.Decimal | null) => {
    const markup = resolveMarkup({ bill: own, project: projectPct.get(projectId), org: settings.reimbursableMarkupPct });
    const m = markedUp(Number(amount), markup.pct);
    return { source, id, projectId, label, date: iso(date), cost: m.cost, markup, markupAmount: m.markup, total: m.total };
  };
  return {
    lines: settings.reimbursableLines,
    items: [
      ...bills.map((b) => item("bill", b.id, b.projectId!, billLabel(b), b.issueDate, b.amount, b.markupPct)),
      ...expenses.map((e) => item("expense", e.id, e.projectId!, expenseLabel(e), e.date, e.amount, null)),
    ],
  };
}

/**
 * A project's unbilled reimbursable costs, oldest first, each with the markup
 * that applies to it and what it would bill at; and the org's line preference.
 */
export async function listUnbilledReimbursables(
  orgId: string,
  projectId: string,
  db: Db = prisma,
): Promise<{ items: UnbilledReimbursable[]; lines: ReimbursableLines }> {
  const { items, lines } = await collectUnbilled(db, orgId, { projectId });
  // Same items, without the projectId the caller already named.
  return { lines, items: items.map((i) => omitProject(i)) };
}

export interface UnbilledTotals {
  count: number;
  cost: number;
  markup: number;
  total: number;
}

export interface ProjectUnbilled {
  projectId: string;
  projectKey: string;
  projectName: string;
  items: UnbilledReimbursable[];
  totals: UnbilledTotals;
}

function omitProject<T extends { projectId: string }>(i: T): Omit<T, "projectId"> {
  const { projectId, ...rest } = i;
  void projectId;
  return rest;
}

/** Summed in integer cents, so a project's totals are exactly the sum of its rows. */
function totalsOf(items: readonly UnbilledReimbursable[]): UnbilledTotals {
  const c = (n: number) => Math.round(n * 100);
  const cost = items.reduce((s, i) => s + c(i.cost), 0);
  const markup = items.reduce((s, i) => s + c(i.markupAmount), 0);
  return { count: items.length, cost: cost / 100, markup: markup / 100, total: (cost + markup) / 100 };
}

/**
 * Unbilled reimbursable costs grouped by project, for the reports that show
 * what is still to be billed: one project (`projectId`), or every project the
 * caller can see (`visible`, in the WHERE so a hidden project's costs are never
 * read). Projects with nothing unbilled are left out; projects are ordered by
 * key. Each project carries its totals, and so does the whole.
 */
export async function unbilledReimbursablesByProject(
  orgId: string,
  scope: Scope,
): Promise<{ projects: ProjectUnbilled[]; totals: UnbilledTotals; lines: ReimbursableLines }> {
  const { items, lines } = await collectUnbilled(prisma, orgId, scope);
  const byProject = new Map<string, UnbilledReimbursable[]>();
  for (const { projectId, ...i } of items) {
    const list = byProject.get(projectId) ?? [];
    list.push(i);
    byProject.set(projectId, list);
  }
  const meta = byProject.size
    ? await prisma.project.findMany({ where: { orgId, id: { in: [...byProject.keys()] } }, select: { id: true, key: true, name: true } })
    : [];
  const projects = meta
    .map((p) => {
      const rows = byProject.get(p.id)!;
      return { projectId: p.id, projectKey: p.key, projectName: p.name, items: rows, totals: totalsOf(rows) };
    })
    .sort((a, b) => a.projectKey.localeCompare(b.projectKey));
  return { projects, totals: totalsOf(projects.flatMap((p) => p.items)), lines };
}

const withDetail = {
  lineItems: { orderBy: { sortOrder: "asc" } },
  payments: { orderBy: { receivedAt: "asc" } },
} satisfies Prisma.InvoiceInclude;

/**
 * Add a project's unbilled reimbursable costs to its draft invoice: all of
 * them, or only the ones picked. A picked cost that is not unbilled and
 * reimbursable on this invoice's project is refused, and nothing is added.
 */
export async function addReimbursables(
  orgId: string,
  invoiceId: string,
  pick?: { billIds?: string[]; expenseIds?: string[] },
) {
  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id: invoiceId, orgId },
      select: { status: true, projectId: true, lineItems: { select: { amount: true, taxRate: true, sortOrder: true } } },
    });
    if (!inv) throw new NotFoundError("Invoice not found");
    if (inv.status !== "DRAFT") throw new ConflictError("Only a draft invoice can take reimbursables");
    if (!inv.projectId) throw new ConflictError("Set the invoice's project before adding its reimbursables");

    const { items, lines: mode } = await listUnbilledReimbursables(orgId, inv.projectId, tx);
    let chosen = items;
    if (pick && (pick.billIds || pick.expenseIds)) {
      const want = new Set([...(pick.billIds ?? []).map((id) => `bill:${id}`), ...(pick.expenseIds ?? []).map((id) => `expense:${id}`)]);
      chosen = items.filter((i) => want.has(`${i.source}:${i.id}`));
      if (chosen.length !== want.size) {
        throw new ConflictError("Some of those costs are already billed, or aren't reimbursable costs on this invoice's project");
      }
    }
    if (chosen.length === 0) {
      return { invoice: await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: withDetail }), added: 0 };
    }

    // Claim each cost. A count of 0 means another invoice took it since the
    // read above; throwing rolls back every claim and line in this call.
    for (const c of chosen) {
      const where = { id: c.id, orgId, ...UNBILLED };
      const claimed =
        c.source === "bill"
          ? await tx.bill.updateMany({ where, data: { invoiceId } })
          : await tx.expense.updateMany({ where, data: { invoiceId } });
      if (claimed.count !== 1) throw new ConflictError("A cost was billed on another invoice meanwhile — please retry");
    }

    const costs: RebillCost[] = chosen.map((c) => ({ source: c.source, id: c.id, label: c.label, cost: c.cost, pct: c.markup.pct }));
    const start = inv.lineItems.reduce((m, l) => Math.max(m, l.sortOrder + 1), 0);
    const rows = rebillLines(costs, mode).map((l, i) => {
      const quantity = D(l.quantity);
      const unitPrice = D(l.unitPrice);
      return {
        invoiceId,
        description: l.description,
        quantity,
        unitPrice,
        taxRate: D(0),
        amount: lineAmount(quantity, unitPrice),
        sortOrder: start + i,
        billId: l.billId,
        expenseId: l.expenseId,
        reimbursableKind: l.reimbursableKind,
        passThroughAmount: D(l.passThroughAmount),
      };
    });
    await tx.invoiceLineItem.createMany({ data: rows });

    const totals = invoiceTotals([...inv.lineItems, ...rows]);
    const invoice = await tx.invoice.update({
      where: { id: invoiceId },
      data: { subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total },
      include: withDetail,
    });
    return { invoice, added: chosen.length };
  });
}

/** What an invoice edit may say about a re-billed line: which cost, and which kind of line. */
export interface LineTag {
  billId?: string | null;
  expenseId?: string | null;
  reimbursableKind?: RebillKind | null;
}

const tagKey = (t: LineTag) =>
  t.billId ? `bill:${t.billId}:${t.reimbursableKind}` : t.expenseId ? `expense:${t.expenseId}:${t.reimbursableKind}` : null;

/**
 * The edit-safety half: an invoice edit replaces every line, so a re-billed
 * line survives only if the edit sends its tag back. The tag must match a
 * re-billed line the invoice already has (it can be kept or removed, never
 * invented: a line becomes a re-billed one only through addReimbursables),
 * and its pass-through is the snapshot taken when it was added, capped at the
 * line's new amount so a discounted line can't book more than itself as cost.
 *
 * Returns the pass-through for each input line (null for an ordinary line),
 * and a `release` to run after the lines are replaced: every cost this
 * invoice re-billed whose lines are all gone goes back to unbilled.
 */
export async function reconcileReimbursableLines(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  lines: readonly (LineTag & { amount: Prisma.Decimal })[],
  nextProjectId: string | null | undefined,
) {
  const existing = await tx.invoiceLineItem.findMany({
    where: { invoiceId, reimbursableKind: { not: null } },
    select: { billId: true, expenseId: true, reimbursableKind: true, passThroughAmount: true },
  });
  const snapshot = new Map(existing.map((l) => [tagKey(l), l.passThroughAmount ?? D(0)]));

  const seen = new Set<string>();
  const passThrough = lines.map((l) => {
    if (!l.billId && !l.expenseId && !l.reimbursableKind) return null;
    const key = l.billId && l.expenseId ? null : tagKey(l);
    if (!key || !l.reimbursableKind || !snapshot.has(key)) {
      throw new ConflictError("A re-billed line can be kept or removed, not added by hand: use Add reimbursables");
    }
    if (seen.has(key)) throw new ConflictError("The same re-billed line appears twice");
    seen.add(key);
    return Prisma.Decimal.min(snapshot.get(key)!, l.amount);
  });

  const keptBills = lines.flatMap((l) => (l.billId ? [l.billId] : []));
  const keptExpenses = lines.flatMap((l) => (l.expenseId ? [l.expenseId] : []));
  // The costs belong to the invoice's project; moving the invoice to another
  // would bill one project's costs to another's client.
  if (nextProjectId !== undefined && (keptBills.length || keptExpenses.length)) {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { projectId: true } });
    if (nextProjectId !== inv.projectId) {
      throw new ConflictError("Remove the re-billed lines before moving the invoice to another project");
    }
  }

  return {
    passThrough,
    // Only costs this invoice re-billed through a line: a bill linked to the
    // invoice by hand (bill PATCH invoiceId) has no line to lose, and stays.
    release: async () => {
      const hadBills = existing.flatMap((l) => (l.billId ? [l.billId] : [])).filter((id) => !keptBills.includes(id));
      const hadExpenses = existing.flatMap((l) => (l.expenseId ? [l.expenseId] : [])).filter((id) => !keptExpenses.includes(id));
      if (hadBills.length) {
        await tx.bill.updateMany({ where: { orgId, invoiceId, id: { in: hadBills } }, data: { invoiceId: null } });
      }
      if (hadExpenses.length) {
        await tx.expense.updateMany({ where: { orgId, invoiceId, id: { in: hadExpenses } }, data: { invoiceId: null } });
      }
    },
  };
}
