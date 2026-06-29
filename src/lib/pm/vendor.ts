import { Prisma } from "@prisma/client";

/** Partner fields surfaced on a vendor row (the sub/vendor behind the contract). */
export const partnerSelect = {
  id: true,
  name: true,
  type: true,
  status: true,
  socioEconomic: true,
  cageCode: true,
  perfRating: true,
  ndaOnFile: true,
  ndaExpiry: true,
  pocName: true,
  pocEmail: true,
} as const;

export type VendorContract = Prisma.ContractGetPayload<{
  include: { partner: { select: typeof partnerSelect } };
}>;

const num = (d: Prisma.Decimal | null) => (d != null ? Number(d) : null);

/**
 * Shape a Contract (+ its Partner) into a vendor-register row, with the
 * per-vendor burn derived: % of funded that's been invoiced, and remaining.
 */
export function mapVendorContract(c: VendorContract) {
  const value = num(c.value); // contract ceiling
  const funded = num(c.fundedValue);
  const invoiced = num(c.invoicedValue);
  const pctBurnedFunded =
    funded && funded > 0 && invoiced != null ? Math.round((invoiced / funded) * 100) : null;
  const remainingFunded =
    funded != null && invoiced != null ? Math.round((funded - invoiced) * 100) / 100 : null;
  const p = c.partner;
  return {
    id: c.id,
    partnerId: c.partnerId,
    partner: p
      ? {
          id: p.id,
          name: p.name,
          type: p.type,
          status: p.status,
          socioEconomic: p.socioEconomic,
          cageCode: p.cageCode,
          perfRating: p.perfRating,
          ndaOnFile: p.ndaOnFile,
          ndaExpiry: p.ndaExpiry ? p.ndaExpiry.toISOString() : null,
          pocName: p.pocName,
          pocEmail: p.pocEmail,
        }
      : null,
    title: c.title,
    value,
    fundedValue: funded,
    invoicedValue: invoiced,
    remainingFunded,
    pctBurnedFunded,
    paymentTerms: c.paymentTerms,
    agmtType: c.agmtType,
    agmtNumber: c.agmtNumber,
    currency: c.currency,
    status: c.status,
    startDate: c.startDate ? c.startDate.toISOString() : null,
    endDate: c.endDate ? c.endDate.toISOString() : null,
  };
}
