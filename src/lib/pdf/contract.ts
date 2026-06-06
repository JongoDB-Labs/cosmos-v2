import PDFDocument from "pdfkit";

export interface ContractPdfInput {
  title: string;
  partyName: string;
  partyEmail?: string | null;
  value?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  body?: string | null;
  signedAt?: Date | null;
}

export function generateContractPdf(input: ContractPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 72, bottom: 72, left: 72, right: 72 } });

    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(input.title, { align: "center" });
    doc.moveDown(1);
    doc.fontSize(10).fillColor("#666").text(`Generated ${new Date().toISOString()}`, { align: "center" });
    doc.moveDown(2);
    doc.fontSize(11).fillColor("black");

    const meta: [string, string][] = [
      ["Party", input.partyName],
      ["Email", input.partyEmail ?? "—"],
      ["Value", input.value != null ? `$${input.value.toLocaleString()}` : "—"],
      ["Start", input.startDate ? input.startDate.toLocaleDateString() : "—"],
      ["End", input.endDate ? input.endDate.toLocaleDateString() : "—"],
      ["Status", input.signedAt ? `Signed ${input.signedAt.toLocaleDateString()}` : "Unsigned"],
    ];
    for (const [k, v] of meta) {
      doc.font("Helvetica-Bold").text(`${k}: `, { continued: true });
      doc.font("Helvetica").text(v);
    }

    doc.moveDown(2);
    doc.font("Helvetica").fontSize(11).text(input.body ?? "");

    doc.end();
  });
}
