import PDFDocument from "pdfkit";
import type { OrgBrandOverrides } from "@/lib/brand/resolve";
import { PDF_LOGO_FIT, resolvePdfLogo, resolvePdfPalette } from "./brand";

export interface ContractPdfInput {
  title: string;
  partyName: string;
  partyEmail?: string | null;
  value?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  body?: string | null;
  signedAt?: Date | null;
  /**
   * The issuing org's brand. Optional: omitted (as in the neutral build) the
   * document renders through the unbranded palette exactly as it always has.
   */
  brand?: OrgBrandOverrides | null;
}

export function generateContractPdf(input: ContractPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 72, bottom: 72, left: 72, right: 72 } });

    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const palette = resolvePdfPalette(input.brand);
    const logo = resolvePdfLogo(input.brand?.logoUrl);

    if (logo) {
      // Centred over the text column, above the title. The fit box's full
      // height is reserved rather than the drawn image's, so the title lands in
      // the same place whatever the logo's aspect ratio. A logo that will not
      // draw must never fail the export — the contract matters, the mark does not.
      try {
        const [logoWidth, logoHeight] = PDF_LOGO_FIT;
        const column = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const top = doc.y;
        doc.image(logo, doc.page.margins.left + (column - logoWidth) / 2, top, {
          fit: PDF_LOGO_FIT,
        });
        doc.y = top + logoHeight + 12;
      } catch {
        // fall through unbranded
      }
    }

    doc.font(palette.fontBold).fontSize(18).fillColor(palette.strong).text(input.title, { align: "center" });
    doc.moveDown(1);
    doc.font(palette.fontRegular).fontSize(10).fillColor(palette.meta).text(`Generated ${new Date().toISOString()}`, { align: "center" });
    doc.moveDown(2);
    doc.fontSize(11).fillColor(palette.body);

    const meta: [string, string][] = [
      ["Party", input.partyName],
      ["Email", input.partyEmail ?? "—"],
      ["Value", input.value != null ? `$${input.value.toLocaleString()}` : "—"],
      ["Start", input.startDate ? input.startDate.toLocaleDateString() : "—"],
      ["End", input.endDate ? input.endDate.toLocaleDateString() : "—"],
      ["Status", input.signedAt ? `Signed ${input.signedAt.toLocaleDateString()}` : "Unsigned"],
    ];
    for (const [k, v] of meta) {
      doc.font(palette.fontBold).fillColor(palette.strong).text(`${k}: `, { continued: true });
      doc.font(palette.fontRegular).fillColor(palette.body).text(v);
    }

    doc.moveDown(2);
    doc.font(palette.fontRegular).fontSize(11).fillColor(palette.body).text(input.body ?? "");

    doc.end();
  });
}
