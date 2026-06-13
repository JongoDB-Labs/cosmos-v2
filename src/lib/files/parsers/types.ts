export type BlockKind = "HEADING" | "PARAGRAPH" | "LIST" | "TABLE" | "CODE" | "IMAGE" | "QUOTE" | "PAGE_BREAK";
export interface ParsedBlock {
  kind: BlockKind;
  level?: number;            // heading depth 1..6
  text: string;              // normalized plain text (always present, may be "")
  html?: string;             // optional richer render (lists/tables)
  data?: unknown;            // structured payload (table: {rows: string[][]})
  page?: number;             // source page/slide
}
export interface ParseResult { blocks: ParsedBlock[]; pageCount?: number }
export interface DocumentParser {
  formats: string[];                                   // e.g. ["docx"]
  parse(buf: Buffer, opts?: { maxBytes?: number }): Promise<ParseResult>;
}
