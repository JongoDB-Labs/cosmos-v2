import mammoth from "mammoth";
import type { DocumentParser } from "./types";
import { htmlToBlocks } from "./html-to-blocks";

export const docxParser: DocumentParser = {
  formats: ["docx"],
  async parse(buf) {
    const { value: html } = await mammoth.convertToHtml({ buffer: buf });
    return { blocks: htmlToBlocks(html) };
  },
};
