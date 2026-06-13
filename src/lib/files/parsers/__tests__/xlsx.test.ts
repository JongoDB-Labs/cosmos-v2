import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { xlsxParser } from "../xlsx";

const FIX = join(process.cwd(), "src/lib/files/parsers/__tests__/fixtures");

describe("xlsxParser", () => {
  it("emits a HEADING + TABLE per sheet", async () => {
    const { blocks, pageCount } = await xlsxParser.parse(readFileSync(join(FIX, "sample.xlsx")));
    expect(pageCount).toBe(2);
    expect(blocks.filter((b) => b.kind === "TABLE").length).toBe(2);
    const t = blocks.find((b) => b.kind === "TABLE")!;
    expect((t.data as { rows: string[][] }).rows.length).toBeGreaterThan(1);
  });
});
