import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pptxParser } from "../pptx";

const FIX = join(process.cwd(), "src/lib/files/parsers/__tests__/fixtures");

describe("pptxParser", () => {
  it("emits a HEADING per slide + paragraph text", async () => {
    const { blocks, pageCount } = await pptxParser.parse(readFileSync(join(FIX, "sample.pptx")));
    expect(pageCount).toBe(2);
    expect(blocks.filter((b) => b.kind === "HEADING").length).toBe(2);
    expect(blocks.some((b) => b.kind === "PARAGRAPH" && b.text.length > 0)).toBe(true);
  });
});
