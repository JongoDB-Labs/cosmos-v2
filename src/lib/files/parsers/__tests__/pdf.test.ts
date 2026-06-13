import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pdfParser } from "../pdf";

const FIX = join(process.cwd(), "src/lib/files/parsers/__tests__/fixtures");

describe("pdfParser", () => {
  it("extracts text blocks + a page break across 2 pages", async () => {
    const { blocks, pageCount } = await pdfParser.parse(readFileSync(join(FIX, "sample.pdf")));
    expect(pageCount).toBe(2);
    expect(blocks.some((b) => b.kind === "PARAGRAPH" && b.text.length > 0)).toBe(true);
    expect(blocks.some((b) => b.kind === "PAGE_BREAK")).toBe(true);
  });
});
