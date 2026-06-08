import { Prisma } from "@prisma/client";
import { Ofx } from "ofx-data-extractor";
import type { ParsedTxn } from "../types";

/**
 * Parse an OFX/QFX file content string into normalized ParsedTxn records.
 *
 * Uses the `Ofx` class from ofx-data-extractor v1.5.x.
 * - Constructor: `new Ofx(data: string)`
 * - Method: `getBankTransferList(): StatementTransaction[]`
 * - StatementTransaction fields: FITID (string), DTPOSTED (string),
 *   TRNAMT (number), NAME? (via index sig), MEMO? (string)
 *
 * TRNAMT is signed from the customer's perspective (negative = money out,
 * positive = money in); we trust it directly — do NOT re-sign via TRNTYPE.
 */
export function parseOfx(content: string): ParsedTxn[] {
  const ofx = new Ofx(content);
  const txns = ofx.getBankTransferList();

  return txns.map((t) => ({
    externalId: t.FITID != null ? String(t.FITID) : null,
    postedDate: parseOfxDate(String(t.DTPOSTED)),
    amount: new Prisma.Decimal(String(t.TRNAMT)),
    description: String((t as Record<string, unknown>).NAME ?? t.MEMO ?? "").trim(),
  }));
}

/**
 * Parse an OFX date value to UTC midnight.
 *
 * ofx-data-extractor v1.5.x pre-formats DTPOSTED to "YYYY-MM-DD" (ISO date).
 * We also handle the raw OFX format: YYYYMMDD or YYYYMMDDHHmmss[.xxx][TZ].
 */
function parseOfxDate(s: string): Date {
  // ISO format: "2026-01-15" or "2026-01-15T..."
  if (s.includes("-")) {
    const [year, month, day] = s.split("T")[0].split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }
  // Raw OFX format: "20260115" or "20260115120000"
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
}
