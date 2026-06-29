 
// TEMP probe — dump template structure. Delete after.
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";

const dir = path.join(process.cwd(), "src/lib/pm/templates");
const files = process.argv[2] ? [process.argv[2]] : fs.readdirSync(dir).filter((f) => f.endsWith(".xlsx"));

for (const file of files) {
  const wb = XLSX.readFile(path.join(dir, file), { cellFormula: true, cellNF: true, cellStyles: true });
  console.log("\n\n############################################################");
  console.log("FILE:", file);
  console.log("SHEETS:", JSON.stringify(wb.SheetNames));
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const ref = ws["!ref"];
    if (!ref) { console.log(`\n--- [${sheetName}] EMPTY ---`); continue; }
    const range = XLSX.utils.decode_range(ref);
    console.log(`\n--- [${sheetName}] ref=${ref} rows=${range.e.r + 1} cols=${range.e.c + 1} ---`);
    // Dump first ~12 rows fully (value + formula)
    const maxRow = Math.min(range.e.r, 14);
    for (let r = range.s.r; r <= maxRow; r++) {
      const cells: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (!cell) continue;
        let repr = "";
        if (cell.f) repr = `=${cell.f}`;
        else if (cell.v !== undefined) repr = JSON.stringify(cell.v);
        cells.push(`${addr}:${repr}`);
      }
      if (cells.length) console.log(`  R${r + 1}| ${cells.join("  ")}`);
    }
    if (range.e.r > maxRow) console.log(`  ... (${range.e.r - maxRow} more rows)`);
  }
}
