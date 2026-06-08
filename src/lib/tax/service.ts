import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { NotFoundError } from "@/lib/rbac/check";
import { ACCOUNT_CODES } from "@/lib/ledger/chart-of-accounts";
import { summarizeTaxLiability, type TaxLiability } from "./liability";

export type TaxRateInput = {
  name: string;
  rate: number | string;
  jurisdiction?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
};

export function listTaxRates(orgId: string) {
  return prisma.taxRate.findMany({
    where: { orgId },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
}

export async function createTaxRate(
  orgId: string,
  createdById: string,
  input: TaxRateInput,
) {
  // Only one default per org.
  if (input.isDefault) {
    await prisma.taxRate.updateMany({
      where: { orgId, isDefault: true },
      data: { isDefault: false },
    });
  }
  return prisma.taxRate.create({
    data: {
      orgId,
      createdById,
      name: input.name,
      rate: new Prisma.Decimal(input.rate),
      jurisdiction: input.jurisdiction ?? null,
      isDefault: input.isDefault ?? false,
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateTaxRate(
  orgId: string,
  taxRateId: string,
  input: Partial<TaxRateInput>,
) {
  if (input.isDefault) {
    await prisma.taxRate.updateMany({
      where: { orgId, isDefault: true, NOT: { id: taxRateId } },
      data: { isDefault: false },
    });
  }
  const data: Prisma.TaxRateUpdateManyMutationInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.rate !== undefined) data.rate = new Prisma.Decimal(input.rate);
  if (input.jurisdiction !== undefined) data.jurisdiction = input.jurisdiction;
  if (input.isDefault !== undefined) data.isDefault = input.isDefault;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  const updated = await prisma.taxRate.updateMany({
    where: { id: taxRateId, orgId },
    data,
  });
  if (updated.count === 0) throw new NotFoundError("Tax rate not found");
  return prisma.taxRate.findUniqueOrThrow({ where: { id: taxRateId } });
}

export async function deleteTaxRate(orgId: string, taxRateId: string) {
  const deleted = await prisma.taxRate.deleteMany({ where: { id: taxRateId, orgId } });
  if (deleted.count === 0) throw new NotFoundError("Tax rate not found");
  return { id: taxRateId, deleted: true };
}

/** Sales-tax liability from the posted GL (Sales Tax Payable credits − debits). */
export async function taxLiability(orgId: string): Promise<TaxLiability> {
  const account = await prisma.account.findUnique({
    where: { orgId_code: { orgId, code: ACCOUNT_CODES.SALES_TAX_PAYABLE } },
    select: { id: true },
  });
  if (!account) return { total: "0", byMonth: [] };

  const lines = await prisma.journalLine.findMany({
    where: { orgId, accountId: account.id, entry: { status: "POSTED" } },
    select: { direction: true, amount: true, entry: { select: { date: true } } },
  });
  return summarizeTaxLiability(
    lines.map((l) => ({ direction: l.direction, amount: l.amount, date: l.entry.date })),
  );
}
