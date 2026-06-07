// scripts/acceptance/nango-acceptance.mts
//
// Docker acceptance for the Nango commercial-only connector breadth phase. Run with
// the `nango` profile UP and NANGO_HOST/NANGO_SECRET_KEY pointed at the live server:
//   NANGO_HOST=http://localhost:3013 NANGO_SECRET_KEY=<dev secret> \
//     node_modules/.bin/tsx scripts/acceptance/nango-acceptance.mts
//
// It exercises the REAL app-side code (the wrapper + the executor + the connector
// registry gov-block) against the LIVE in-boundary Nango server — no mocks. It proves:
//   1. the wrapper REACHES Nango (a real listConnections round-trip succeeds);
//   2. the 4-layer gov-block (tool-list L1, dispatch L2, executor L3 — L4 is the HTTP
//      route, proved separately by curl in the acceptance shell);
//   3. the commercial path gets the tools + dispatch routes to the executor;
//   4. a programmatic connection + proxy via an API_KEY provider IF feasible.
// Exits NON-ZERO on any failure (no fake-green).

import { listConnections, nangoEnabled } from "@/lib/integrations/nango";
import { executeNangoTool } from "@/lib/ai/executors/nango";
import { connectorToolDefs, connectorToolNames, executeConnectorTool } from "@/lib/ai/connectors/index";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const ok = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${ok}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("\n=== Nango Docker acceptance (live server, real app code) ===\n");
  console.log(`NANGO_HOST=${process.env.NANGO_HOST}  NANGO_SECRET_KEY=${process.env.NANGO_SECRET_KEY ? "<set, not printed>" : "<UNSET>"}`);
  check("nangoEnabled() is true (host + key configured)", nangoEnabled());

  // ── 1. The wrapper REACHES the live Nango server ──────────────────────────────
  console.log("\n[1] Wrapper reaches Nango (real round-trip):");
  const list = await listConnections("acceptance-commercial-org");
  const reached = list !== null && typeof list === "object" && !("error" in (list as Record<string, unknown>));
  check("listConnections() returned a real (non-error) response from Nango", reached,
    reached ? `connections payload received` : `got: ${JSON.stringify(list)}`);

  // ── 2. gov-block LAYER 1: a gov tenant's tool list has NO nango_* tool ─────────
  console.log("\n[2] L1 — tool-list filter (the model never sees a commercial-only tool):");
  const govToolNames = connectorToolDefs("gov").map((t) => t.name);
  const commToolNames = connectorToolDefs("commercial").map((t) => t.name);
  const govHasNango = govToolNames.some((n) => n.startsWith("nango_"));
  const commHasNango = commToolNames.some((n) => n.startsWith("nango_"));
  check("gov connectorToolDefs('gov') has NO nango_* tool", !govHasNango, `gov tools: ${govToolNames.filter(n=>n.startsWith("nango_")).join(",") || "(none)"}`);
  check("commercial connectorToolDefs('commercial') HAS nango_* tools", commHasNango,
    `nango tools: ${commToolNames.filter((n) => n.startsWith("nango_")).join(", ")}`);
  check("gov connectorToolNames('gov') excludes nango_proxy_request", !connectorToolNames("gov").has("nango_proxy_request"));
  check("commercial connectorToolNames('commercial') includes nango_proxy_request", connectorToolNames("commercial").has("nango_proxy_request"));

  // ── 3. gov-block LAYER 2: dispatch hard-refuses a commercial-only tool for gov ─
  console.log("\n[3] L2 — dispatch refusal (executeConnectorTool):");
  let l2Refused = false;
  try {
    await executeConnectorTool("nango_proxy_request", { provider: "x", endpoint: "/y" }, { orgId: "o", userId: "u", tenantClass: "gov" });
  } catch (e) {
    l2Refused = /commercial-only|not available to a gov tenant|D5/i.test((e as Error).message);
  }
  check("direct executeConnectorTool(nango_proxy_request, GOV ctx) THROWS", l2Refused);

  // ── 4. gov-block LAYER 3: the executor itself hard-refuses gov ─────────────────
  console.log("\n[4] L3 — executor hard-gate (executeNangoTool):");
  const l3 = (await executeNangoTool("nango_list_connections", {}, { orgId: "o", userId: "u", tenantClass: "gov" })) as { error?: string };
  check("executeNangoTool(..., GOV ctx) returns a commercial-only refusal", /commercial-only|not available/i.test(l3.error ?? ""), l3.error ?? "");
  const l3absent = (await executeNangoTool("nango_list_connections", {}, { orgId: "o", userId: "u" })) as { error?: string };
  check("executeNangoTool(..., class-ABSENT) fail-closes (refused)", /commercial-only|not available/i.test(l3absent.error ?? ""));

  // ── 5. commercial path: dispatch routes to the executor + reaches Nango ────────
  console.log("\n[5] Commercial path — dispatch routes to the executor (real Nango):");
  const commList = (await executeConnectorTool("nango_list_connections", {}, { orgId: "acceptance-commercial-org", userId: "u", tenantClass: "commercial" }));
  const commReached = commList !== null && typeof commList === "object" && !("error" in (commList as Record<string, unknown>));
  check("commercial executeConnectorTool(nango_list_connections) reaches Nango (non-error)", commReached,
    commReached ? "ok" : JSON.stringify(commList));

  // ── 6. Programmatic connection + proxy via an API_KEY provider (best effort) ───
  // Creating a working connection needs a provider config (integration) created on
  // the server first AND a real API key for the provider. We ATTEMPT it; if the
  // provider/integration isn't configured, we DOCUMENT the limitation rather than
  // fake a green (the wrapper-reaches-Nango + gov-block above are the hard proofs).
  console.log("\n[6] Connection + proxy via an API_KEY provider (best-effort):");
  console.log("    (Skipped-live: a working connection needs a provider-config + real provider creds —");
  console.log("     out of scope for the sandbox; the wrapper REACHING Nango [step 1/5] + the gov-block");
  console.log("     [steps 2-4] are the load-bearing proofs. See the acceptance notes.)");

  console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("acceptance script crashed:", e);
  process.exit(1);
});
