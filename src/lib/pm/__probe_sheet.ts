/* eslint-disable */
// TEMP probe — dump ALL rows of one sheet in one file. Delete after.
import * as XLSX from "xlsx";
import * as path from "path";
const file = process.argv[2];
const sheetName = process.argv[3];
const maxRows = process.argv[4] ? Number(process.argv[4]) : 9999;
const dir = path.join(process.cwd(), "src/lib/pm/templates");
const wb = XLSX.readFile(path.join(dir, file), { cellFormula: true, cellNF: true });
const ws = wb.Sheets[sheetName];
const range = XLSX.utils.decode_range(ws["!ref"]!);
console.log(`[${sheetName}] ref=${ws["!ref"]}`);
for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + maxRows); r++) {
  const cells: string[] = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r, c });
    const cell = ws[addr];
    if (!cell) continue;
    let repr = cell.f ? `=${cell.f}` : (cell.v !== undefined ? JSON.stringify(cell.v) : "");
    cells.push(`${addr}:${repr}`);
  }
  if (cells.length) console.log(`R${r + 1}| ${cells.join("  ")}`);
}
