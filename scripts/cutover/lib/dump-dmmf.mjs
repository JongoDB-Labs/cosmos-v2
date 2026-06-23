// Dumps the COMPLETE Prisma DMMF (datamodel) as JSON on stdout, for model-graph.ts.
//
// Why this exists: Prisma 7 slimmed the runtime `Prisma.dmmf` exposed by the generated
// client — it no longer carries `isId`, `@map` column names (`dbName`), relation fields,
// or `primaryKey`. The cutover engine derives its entire schema-driven migration plan
// from exactly that metadata. `@prisma/internals`' getDMMF reparses the schema into the
// FULL DMMF, but it is async + wasm-backed; model-graph.ts shells out to this script once
// (execFileSync) so its `dmmfModels()` accessor can stay synchronous.
import pkg from "@prisma/internals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { getDMMF } = pkg;

// This file lives at <repo>/scripts/cutover/lib/; the schema is at <repo>/prisma/.
// Resolve relative to this file (not cwd) so it works from any working directory.
const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, "../../../prisma/schema.prisma");

const datamodel = readFileSync(schemaPath, "utf8");
const dmmf = await getDMMF({ datamodel });
process.stdout.write(JSON.stringify({ datamodel: dmmf.datamodel }));
