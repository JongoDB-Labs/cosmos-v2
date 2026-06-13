import { extractText, getDocumentProxy } from "unpdf";
import type { DocumentParser, ParsedBlock } from "./types";

export const pdfParser: DocumentParser = {
  formats: ["pdf"],
  async parse(buf) {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const blocks: ParsedBlock[] = [];
    pages.forEach((pageText, i) => {
      const paras = String(pageText)
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      for (const para of paras) blocks.push({ kind: "PARAGRAPH", text: para, page: i + 1 });
      if (i < pages.length - 1) blocks.push({ kind: "PAGE_BREAK", text: "", page: i + 1 });
    });
    return { blocks, pageCount: totalPages };
  },
};
