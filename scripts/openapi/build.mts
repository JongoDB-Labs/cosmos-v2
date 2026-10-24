// scripts/openapi/build.mts
//
// Builds the OpenAPI documents from the route contracts:
//   openapi/cosmos-v1.json           public (stable + beta), COMMITTED, served at /api/v1/openapi.json
//   openapi/cosmos-v1.internal.json  everything, gitignored, staff only
// Run `npm run openapi` after changing a contract; CI's `check:openapi` fails
// when the committed file is stale.
import { writeFileSync } from "node:fs";
import { contractModules } from "../../src/lib/openapi/contracts.generated";
import { buildDocument, collectContracts } from "../../src/lib/openapi/registry";

const contracts = collectContracts(contractModules);
for (const [audience, file] of [
  ["public", "openapi/cosmos-v1.json"],
  ["internal", "openapi/cosmos-v1.internal.json"],
] as const) {
  writeFileSync(file, JSON.stringify(buildDocument(contracts, audience), null, 2) + "\n");
  console.log(`build: ${audience} -> ${file}`);
}
