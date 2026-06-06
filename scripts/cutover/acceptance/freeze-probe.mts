// scripts/cutover/acceptance/freeze-probe.mts — exercise the EXACT freeze predicate the
// request proxy gates on (src/lib/cutover/freeze.ts: isMutatingMethod + isPathOrgFrozen)
// against the LIVE frozen_orgs table. This is the proxy's decision: a mutating verb on a
// frozen org's path ⇒ 405; a read, or any verb on an unfrozen org ⇒ pass.
//
// Env: DATABASE_URL (the target owner URL), TENANT_ID (the org uuid; slug is "tenant").

import { isMutatingMethod, isPathOrgFrozen, unfreezeOrg } from "@/lib/cutover/freeze";

const TENANT = process.env.TENANT_ID!;
if (!TENANT) {
  console.error("freeze-probe: missing TENANT_ID");
  process.exit(1);
}

// The proxy's freeze gate, in one function (mirrors src/proxy.ts).
async function proxyDecision(method: string, pathname: string): Promise<"405" | "PASS"> {
  if (isMutatingMethod(method) && (await isPathOrgFrozen(pathname))) return "405";
  return "PASS";
}

async function main() {
  const apiPath = `/api/v1/orgs/${TENANT}/work-items`;
  const slugPath = `/tenant/projects`;

  // While frozen:
  console.log(`POST /api/v1/orgs/<id> -> ${await proxyDecision("POST", apiPath)}`);
  console.log(`GET  /api/v1/orgs/<id> -> ${await proxyDecision("GET", apiPath)}`);
  console.log(`POST /tenant (slug) -> ${await proxyDecision("POST", slugPath)}`);

  // Now unfreeze and confirm writes pass again.
  await unfreezeOrg(TENANT);
  console.log(`POST after unfrozen -> ${await proxyDecision("POST", apiPath)}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(`freeze-probe: ${e?.stack ?? e}`);
  process.exit(1);
});
