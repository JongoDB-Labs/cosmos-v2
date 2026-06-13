import * as XLSX from "xlsx";
import type { DocumentParser, ParsedBlock } from "./types";

export const xlsxParser: DocumentParser = {
  formats: ["xlsx", "xls"],
  async parse(buf) {
    const wb = XLSX.read(buf, { type: "buffer" });
    const blocks: ParsedBlock[] = [];
    wb.SheetNames.forEach((name, i) => {
      const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], {
        header: 1,
        blankrows: false,
        defval: "",
      });
      blocks.push({ kind: "HEADING", level: 2, text: name, page: i + 1 });
      if (rows.length) {
        blocks.push({
          kind: "TABLE",
          text: rows.map((r) => r.join(" | ")).join("\n"),
          data: { rows },
          page: i + 1,
        });
      }
    });
    return { blocks, pageCount: wb.SheetNames.length };
  },
};
