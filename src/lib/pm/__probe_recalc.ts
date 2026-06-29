/* eslint-disable */
import XlsxPopulate from "xlsx-populate";
import * as path from "path";
import * as fs from "fs";
async function main() {
  const tpl = path.join(process.cwd(), "src/lib/pm/templates/risks.xlsx");
  const out = path.join(process.cwd(), "__rt_risks.xlsx");
  const wb = await XlsxPopulate.fromFileAsync(tpl);
  // does the API expose forceFullCalc / fullCalcOnLoad?
  console.log("has wb.forceFormulaUpdate:", typeof (wb as any).forceFormulaUpdate);
  console.log("methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(wb)).filter((m)=>/calc|formula|recalc/i.test(m)));
  wb.sheet("Risk Register").cell("A5").value("R-TEST");
  await wb.toFileAsync(out);
  // inspect workbook.xml for calcPr fullCalcOnLoad
  const AdmZip = require("adm-zip");
  let zip; try { zip = new AdmZip(out); } catch { zip = null; }
  if (zip) {
    const wbxml = zip.getEntry("xl/workbook.xml")?.getData().toString();
    const calcPr = wbxml?.match(/<calcPr[^>]*\/>/)?.[0] ?? "(no calcPr)";
    console.log("calcPr:", calcPr);
  }
  fs.unlinkSync(out);
}
main().then(()=>process.exit(0)).catch((e)=>{console.error(e.message);process.exit(1);});
