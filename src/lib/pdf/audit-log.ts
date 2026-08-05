import PDFDocument from "pdfkit";
import type { OrgBrandOverrides } from "@/lib/brand/resolve";
import { PDF_LOGO_FIT, resolvePdfLogo, resolvePdfPalette } from "./brand";

export interface AuditLogPdfRow {
  createdAt: Date;
  seq: bigint | null;
  userId: string | null;
  /** Resolved display name/email if known; falls back to the raw userId. */
  userLabel?: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  ipAddress: string | null;
  metadata: unknown;
}

export interface AuditLogPdfFilters {
  action?: string | null;
  entity?: string | null;
  userId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface AuditLogPdfIntegrity {
  /** SHA-256 (hex) over the canonical JSON of the INCLUDED rows. */
  sha256: string;
  minSeq: string | null;
  maxSeq: string | null;
  /** Hex of the last included row's WORM hash-chain `row_hash` (chain anchor). */
  tailRowHash: string | null;
  /** HMAC-SHA256 (hex) over the signed manifest, or null when no signing key. */
  signature: string | null;
  signatureAlgo: string; // "hmac-sha256" | "unsigned"
}

export interface AuditLogPdfInput {
  orgName: string;
  exportedBy: string;
  exportedAt: Date;
  filters: AuditLogPdfFilters;
  /** Total rows matching the filter (may exceed the rendered set). */
  fullCount: number;
  rows: AuditLogPdfRow[];
  truncated: boolean;
  /**
   * The exporting org's brand. Optional: omitted (as in the neutral build) the
   * export renders through the unbranded palette exactly as it always has.
   *
   * Presentation only — the integrity digest is computed over the canonical
   * JSON of the rows, never over the rendered bytes, so branding a document
   * cannot affect whether an auditor can verify it.
   */
  brand?: OrgBrandOverrides | null;
}

function filterSummary(f: AuditLogPdfFilters): string {
  const parts: string[] = [];
  if (f.action) parts.push(`action=${f.action}`);
  if (f.entity) parts.push(`entity=${f.entity}`);
  if (f.userId) parts.push(`user=${f.userId}`);
  if (f.startDate) parts.push(`from=${f.startDate}`);
  if (f.endDate) parts.push(`to=${f.endDate}`);
  return parts.length ? parts.join("  ·  ") : "none (all entries)";
}

/**
 * Render a human-readable, tamper-evident PDF of an org's audit log.
 *
 * The footer carries an INTEGRITY BLOCK: a SHA-256 over the canonical JSON of
 * the rendered rows, the seq range, the tail row's WORM hash-chain `row_hash`
 * (which binds every prior row), and an HMAC-SHA256 signature over a canonical
 * manifest. An auditor can re-export the same window and confirm the digest,
 * and the instance can re-verify the HMAC — so post-hoc edits to either the
 * rows or the manifest are detectable. See generateAuditLogPdf's callers for
 * how the digest/signature are computed (kept in the route so the secret key
 * never leaves the server).
 */
export function generateAuditLogPdf(
  input: AuditLogPdfInput,
  integrity: AuditLogPdfIntegrity,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 54, bottom: 54, left: 54, right: 54 },
      bufferPages: true,
    });
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const palette = resolvePdfPalette(input.brand);
    const logo = resolvePdfLogo(input.brand?.logoUrl);

    // ---- Header ----
    if (logo) {
      // Letterhead position. The fit box's full height is reserved so the
      // heading sits consistently whatever the logo's aspect ratio, and a logo
      // that will not draw is skipped rather than failing the export.
      try {
        const top = doc.y;
        doc.image(logo, doc.page.margins.left, top, { fit: PDF_LOGO_FIT });
        doc.y = top + PDF_LOGO_FIT[1] + 8;
      } catch {
        // fall through unbranded
      }
    }
    doc.fontSize(16).font(palette.fontBold).fillColor(palette.strong).text(`${input.orgName} — Audit Log Export`, { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(9).font(palette.fontRegular).fillColor(palette.meta);
    doc.text(`Generated ${input.exportedAt.toISOString()} by ${input.exportedBy}`);
    doc.text(`Filters: ${filterSummary(input.filters)}`);
    doc.text(
      `Entries: ${input.rows.length} rendered of ${input.fullCount} matching` +
        (input.truncated
          ? "  (truncated — use CSV/JSON export for the complete set)"
          : ""),
    );
    doc.moveDown(0.6);
    doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor(palette.rule).stroke();
    doc.moveDown(0.6);

    // ---- Entries ----
    if (input.rows.length === 0) {
      doc.fontSize(10).font(palette.fontRegular).fillColor(palette.meta).text("No audit entries match the selected filters.");
    }
    for (const r of input.rows) {
      const seqStr = r.seq != null ? `#${r.seq.toString()}` : "—";
      const who = r.userLabel || r.userId || "system";
      doc.fontSize(9).font(palette.fontBold).fillColor(palette.strong);
      doc.text(`${r.action}`, { continued: true });
      doc.font(palette.fontRegular).fillColor(palette.body).text(`  ·  ${r.entity}${r.entityId ? ` (${r.entityId})` : ""}`);
      doc.fontSize(8).font(palette.fontRegular).fillColor(palette.meta);
      doc.text(
        `${r.createdAt.toISOString()}   seq ${seqStr}   by ${who}` +
          (r.ipAddress ? `   ip ${r.ipAddress}` : ""),
      );
      // Compact, bounded metadata line.
      let metaStr = "";
      try {
        metaStr = JSON.stringify(r.metadata ?? {});
      } catch {
        metaStr = "";
      }
      if (metaStr && metaStr !== "{}") {
        if (metaStr.length > 240) metaStr = metaStr.slice(0, 240) + "…";
        doc.fillColor(palette.faint).text(metaStr);
      }
      doc.moveDown(0.4);
    }

    // ---- Integrity block (its own page so it's never split) ----
    doc.addPage();
    doc.fontSize(13).font(palette.fontBold).fillColor(palette.strong).text("Integrity & Signature");
    doc.moveDown(0.4);
    doc.fontSize(9).font(palette.fontRegular).fillColor(palette.body);
    const sig = integrity.signature;
    const lines: [string, string][] = [
      ["Rendered rows", String(input.rows.length)],
      ["Total matching", String(input.fullCount)],
      ["Seq range", `${integrity.minSeq ?? "—"} … ${integrity.maxSeq ?? "—"}`],
      ["Chain anchor (tail row_hash)", integrity.tailRowHash ?? "— (no rows)"],
      ["Content digest (SHA-256)", integrity.sha256],
      ["Signature algorithm", integrity.signatureAlgo],
      ["Signature", sig ?? "unsigned — no signing key configured"],
    ];
    for (const [k, v] of lines) {
      doc.font(palette.fontBold).fillColor(palette.strong).text(`${k}:`);
      doc.font(palette.fontMono).fontSize(8).fillColor(palette.body).text(v, { width: 504 });
      doc.fontSize(9);
      doc.moveDown(0.3);
    }
    doc.moveDown(0.6);
    doc.fontSize(8).font(palette.fontRegular).fillColor(palette.meta).text(
      "The content digest is a SHA-256 over the canonical JSON of the rendered rows " +
        "(id, seq, createdAt, userId, action, entity, entityId, ipAddress, metadata, row_hash, prev_hash). " +
        "The chain anchor is the tail row's AU-9 hash-chain row_hash, which cryptographically binds every prior row. " +
        "The signature is an HMAC-SHA256 over the canonical manifest {orgName, exportedBy, exportedAt, filters, fullCount, renderedCount, minSeq, maxSeq, tailRowHash, sha256}; " +
        "the issuing COSMOS instance can re-verify it to detect any post-export edit to the rows or this manifest.",
    );

    // ---- Page numbers ----
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).font(palette.fontRegular).fillColor(palette.faint).text(
        `Page ${i - range.start + 1} of ${range.count}`,
        54,
        770,
        { align: "right", width: 504 },
      );
    }

    doc.end();
  });
}
