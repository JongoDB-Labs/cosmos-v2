import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docxParser } from "../docx";

const FIX = join(process.cwd(), "src/lib/files/parsers/__tests__/fixtures");

describe("docxParser", () => {
  it("extracts heading + paragraph + table blocks", async () => {
    const { blocks } = await docxParser.parse(readFileSync(join(FIX, "sample.docx")));
    expect(blocks.find((b) => b.kind === "HEADING")?.text).toContain("Deliverables");
    expect(blocks.some((b) => b.kind === "PARAGRAPH")).toBe(true);
    const table = blocks.find((b) => b.kind === "TABLE");
    expect(table).toBeTruthy();
    expect((table!.data as { rows: string[][] }).rows.length).toBe(2);
  });
});
