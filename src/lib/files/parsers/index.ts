import type { DocumentParser } from "./types";
import { docxParser } from "./docx";
import { xlsxParser } from "./xlsx";
import { pdfParser } from "./pdf";
import { pptxParser } from "./pptx";

const ALL = [docxParser, xlsxParser, pdfParser, pptxParser];

export const SUPPORTED_FORMATS = ALL.flatMap((p) => p.formats);

export function parserFor(format: string): DocumentParser | null {
  return ALL.find((p) => p.formats.includes(format)) ?? null;
}

/** Map a filename to a supported format key, or null if unsupported. */
export function formatFromName(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return SUPPORTED_FORMATS.includes(ext) ? ext : null;
}
