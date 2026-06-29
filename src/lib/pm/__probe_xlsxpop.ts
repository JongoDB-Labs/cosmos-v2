/* eslint-disable */
// TEMP — does xlsx-populate preserve burn charts + recompute formulas? Delete after.
import XlsxPopulate from "xlsx-populate";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

async function main() {
  const tpl = path.join(process.cwd(), "src/lib/pm/templates/burn.xlsx");
  const out = path.join(process.cwd(), "__burn_roundtrip.xlsx");
  const wb = await XlsxPopulate.fromFileAsync(tpl);
  // write a value into a monthly Prime Actuals input cell
  const mar = wb.sheet("📅 Mar");
  console.log("Mar E7 before:", mar.cell("E7").value());
  mar.cell("E7").value(99999);
  // also confirm we can read a formula cell and it stays a formula
  console.log("Mar G7 formula:", mar.cell("G7").formula());
  await wb.toFileAsync(out);
  const list = execSync(`unzip -l "${out}"`).toString();
  const charts = (list.match(/xl\/charts\/chart\d+\.xml/g) || []).length;
  const drawings = (list.match(/xl\/drawings\/drawing\d+\.xml/g) || []).length;
  console.log(`\nROUND-TRIP charts=${charts} drawings=${drawings}`);
  // reopen and check formula + value preserved
  const wb2 = await XlsxPopulate.fromFileAsync(out);
  const m2 = wb2.sheet("📅 Mar");
  console.log("Reopened Mar E7:", m2.cell("E7").value(), "| G7 formula:", m2.cell("G7").formula());
  console.log("Sheets preserved:", wb2.sheets().map((s: any) => s.name()).length);
  fs.unlinkSync(out);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
