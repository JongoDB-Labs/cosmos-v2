// Docker acceptance harness for the Microsoft 365 (Microsoft Graph) connector (v2.23).
// Run INSIDE the cosmos-v2-migrate image (the build stage: full source + prisma + tsx)
// against the live acceptance Postgres. Proves the connector end-to-end on a REAL DB with
// NO real Microsoft 365 — the token endpoint + Graph are MOCKED to prove the MECHANICS:
//
//   [1] install seals the secret: drive the install codepath (splitConfigSecrets +
//       setOrgCredential + Integration.create) with config {clientId, clientSecret:
//       'M365SECRET', tenantId, cloud:'gov'} ⇒ Integration.config has NO 'M365SECRET'
//       (only the non-secret cloud), the sealed connector_credentials row exists and is a
//       `v2.<kid>` envelope, and getOrgCredential returns {clientId,clientSecret,tenantId}.
//   [2] gov-cloud client-credentials token exchange (mock token endpoint): getGraphToken
//       for cloud:'gov' targets login.microsoftonline.us + scope graph.microsoft.us/.default
//       (assert the URL + scope), and a 2nd call is served from cache (no re-exchange).
//   [3] dispatch + egress: executeTool('m365_list_messages', …) ROUTES to the m365 executor
//       (graceful not-connected OR a mocked Graph result); a gov-tenant m365 result is
//       STRUCTURAL-ONLY (no subject/body/from/displayName/mail) via the real egress
//       projection, while a commercial tenant sees the full executor shape.
//
// Usage (in-container): node_modules/.bin/tsx scripts/accept/m365-connector-accept.ts
import { prisma } from "@/lib/db/client";
import { IntegrationRegistry } from "@/lib/integrations/registry";
import "@/lib/integrations/registry/index"; // populate the catalog
import { splitConfigSecrets } from "@/lib/integrations/config-secrets";
import { setOrgCredential, getOrgCredential } from "@/lib/integrations/credentials";
import {
  getGraphToken,
  graphFetch,
  _resetGraphTokenCache,
  type FetchLike,
} from "@/lib/integrations/microsoft-graph";
import { executeMicrosoft365Tool } from "@/lib/ai/executors/microsoft365";
import { entityTypeForTool, projectResult } from "@/lib/ai/egress/projection";
import "@/lib/ai/connectors"; // ensure descriptors registered (egress maps merged)
import type { Prisma } from "@prisma/client";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

const SECRET = "M365SECRET";
const CLIENT_ID = "client-id-abc";
const TENANT_ID = "tenant-guid-xyz";
const MOCK_ACCESS_TOKEN = "MOCK-AAD-TOKEN-DO-NOT-LEAK";

/** A mock fetch: token endpoint returns a fresh token; Graph returns the supplied body. */
function mockGraphFetch(graphBody: unknown): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const isToken = url.includes("/oauth2/v2.0/token");
    const body = isToken
      ? { access_token: MOCK_ACCESS_TOKEN, expires_in: 3600 }
      : graphBody;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

async function main() {
  const slug = `accept-m365-${Date.now()}`;
  const org = await prisma.organization.create({
    data: { name: "Accept M365", slug, tenantClass: "GOV" },
  });
  // installedById is NOT nullable — create a throwaway installer user (cascades on org? no,
  // user has no org FK; delete it explicitly at the end).
  const installer = await prisma.user.create({
    data: { email: `installer-${slug}@example.test`, displayName: "Installer" },
  });

  // ── [1] install seals the secret ────────────────────────────────────────────
  console.log("\n=== [1] install microsoft365 (clientSecret + cloud:'gov') seals the secret ===");
  const provider = IntegrationRegistry.get("microsoft365");
  assert(!!provider, "microsoft365 is in the catalog");
  assert(provider!.status === "available" && provider!.connect === "config", "microsoft365 is available + connect:config");

  const submitted = {
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    tenantId: TENANT_ID,
    cloud: "gov",
  };
  // Exactly what the install route does: split secrets, seal them, persist non-secret config.
  const { publicConfig, secrets, hasSecrets } = splitConfigSecrets(provider, submitted);
  assert(hasSecrets, "splitConfigSecrets flagged secret fields");
  // clientId/clientSecret/tenantId are all secret:true ⇒ sealed; only `cloud` is public.
  assert(!("clientSecret" in publicConfig), "clientSecret is NOT in publicConfig");
  assert(!("clientId" in publicConfig), "clientId is NOT in publicConfig (sealed)");
  assert(!("tenantId" in publicConfig), "tenantId is NOT in publicConfig (sealed)");
  assert(publicConfig.cloud === "gov", "publicConfig carries the non-secret cloud:'gov'");

  await setOrgCredential(org.id, "microsoft365", secrets);
  const integration = await prisma.integration.create({
    data: {
      orgId: org.id,
      provider: "microsoft365",
      displayName: "Microsoft 365",
      config: publicConfig as Prisma.InputJsonValue,
      status: "ACTIVE",
      installedById: installer.id,
    },
  });

  // Integration.config in the DB has NO secret material.
  const persisted = await prisma.integration.findUniqueOrThrow({
    where: { id: integration.id },
    select: { config: true },
  });
  const persistedConfigJson = JSON.stringify(persisted.config);
  assert(!persistedConfigJson.includes(SECRET), "DB Integration.config does NOT contain the clientSecret");
  assert(!persistedConfigJson.includes(CLIENT_ID), "DB Integration.config does NOT contain the clientId (sealed)");
  assert(persistedConfigJson.includes('"cloud":"gov"'), "DB Integration.config carries cloud:'gov'");

  // The sealed connector_credentials row exists and is a v2.<kid> vault envelope.
  const credRow = await prisma.connectorCredential.findFirstOrThrow({
    where: { orgId: org.id, provider: "microsoft365", userId: null },
    select: { secretEnc: true },
  });
  assert(/^v2\.[A-Za-z0-9_-]+\./.test(credRow.secretEnc), `connector_credentials row is a v2.<kid> envelope (${credRow.secretEnc.split(".").slice(0, 2).join(".")}.…)`);
  assert(!credRow.secretEnc.includes(SECRET), "the sealed envelope is NOT plaintext (no clientSecret substring)");

  // getOrgCredential unseals back to the original bundle.
  const bundle = await getOrgCredential(org.id, "microsoft365");
  assert(!!bundle && bundle.clientId === CLIENT_ID && bundle.clientSecret === SECRET && bundle.tenantId === TENANT_ID, "getOrgCredential returns {clientId,clientSecret,tenantId}");

  // ── [2] gov-cloud client-credentials token exchange (mocked) ─────────────────
  console.log("\n=== [2] getGraphToken (gov) hits login.microsoftonline.us + graph.microsoft.us scope + caches ===");
  _resetGraphTokenCache();
  const tokFetch = mockGraphFetch({ value: [] });
  const tok = await getGraphToken(org.id, { fetchImpl: tokFetch });
  assert(!("error" in tok), "getGraphToken succeeded (mock token endpoint)");
  if (!("error" in tok)) {
    assert(tok.cloud === "gov", "token exchange resolved cloud:'gov'");
    assert(tok.graphBaseUrl === "https://graph.microsoft.us/v1.0", "gov Graph base URL is the .us cloud");
  }
  const tokenUrl = tokFetch.calls[0];
  assert(tokenUrl === `https://login.microsoftonline.us/${TENANT_ID}/oauth2/v2.0/token`, `token exchange targets login.microsoftonline.us authority (${tokenUrl})`);
  // The 2nd call is served from cache (still ONE token-endpoint hit).
  await getGraphToken(org.id, { fetchImpl: tokFetch });
  const tokenHits = tokFetch.calls.filter((u) => u.includes("/oauth2/v2.0/token")).length;
  assert(tokenHits === 1, "2nd getGraphToken is served from cache (one token exchange)");

  // graphFetch presents the token to the .us Graph base + scope is graph.microsoft.us/.default.
  _resetGraphTokenCache();
  const gFetch = mockGraphFetch({ value: [{ id: "u1", accountEnabled: true }] });
  const gres = await graphFetch(org.id, "/users", { fetchImpl: gFetch });
  assert(gres.ok, "graphFetch('/users') succeeded against the mock");
  const exchangeBody = await (async () => {
    // re-run a raw exchange to capture the scope param (the mock records URLs only;
    // assert scope via a direct getGraphToken with a body-capturing fetch).
    let captured = "";
    const capFetch: FetchLike = async (url, init) => {
      if (url.includes("/oauth2/v2.0/token")) captured = init?.body ?? "";
      return { ok: true, status: 200, json: async () => ({ access_token: MOCK_ACCESS_TOKEN, expires_in: 3600 }), text: async () => "" };
    };
    _resetGraphTokenCache();
    await getGraphToken(org.id, { fetchImpl: capFetch });
    return captured;
  })();
  assert(decodeURIComponent(exchangeBody).includes("scope=https://graph.microsoft.us/.default"), "gov token exchange requests the graph.microsoft.us/.default scope");
  assert(decodeURIComponent(exchangeBody).includes("grant_type=client_credentials"), "the grant is client_credentials");
  const graphUsersUrl = gFetch.calls.find((u) => u.includes("graph.microsoft"));
  assert(graphUsersUrl === "https://graph.microsoft.us/v1.0/users", `graphFetch targets the .us Graph base (${graphUsersUrl})`);

  // ── [3] dispatch + egress ────────────────────────────────────────────────────
  console.log("\n=== [3] dispatch routes m365_list_messages; gov egress is structural-only, commercial is full ===");
  // The executor uses graphFetch internally; thread the injected fetch so no network is hit.
  _resetGraphTokenCache();
  const msgFetch = mockGraphFetch({
    value: [
      {
        id: "m1",
        receivedDateTime: "2026-06-01T12:00:00Z",
        isRead: false,
        hasAttachments: true,
        importance: "high",
        subject: "CUI//SP exfil path",
        bodyPreview: "secret repro",
        from: { emailAddress: { address: "boss@acme.us", name: "Boss" } },
      },
    ],
  });
  const execResult = (await executeMicrosoft365Tool(
    "m365_list_messages",
    { userId: "u1" },
    { orgId: org.id, userId: "00000000-0000-0000-0000-0000000000bb", fetchImpl: msgFetch },
  )) as { messages: Array<Record<string, unknown>> } | null;
  assert(execResult !== null, "executeMicrosoft365Tool routed m365_list_messages (not null)");
  assert(Array.isArray(execResult!.messages) && execResult!.messages.length === 1, "executor returned the (full, pre-gate) message shape");
  // Commercial tenant: the loop surfaces the FULL executor result (no gov projection).
  const commercialView = execResult!.messages[0];
  assert(commercialView.subject === "CUI//SP exfil path", "commercial tenant sees the message subject (content)");
  assert(commercialView.from === "boss@acme.us", "commercial tenant sees the from address (PII)");

  // Gov tenant: the loop projects the executor result through the egress chokepoint
  // (the SAME entityTypeForTool → projectResult path the agent loop uses for gov).
  const entityType = entityTypeForTool("m365_list_messages");
  assert(entityType === "m365_message", "m365_list_messages maps to the m365_message entity");
  const govView = projectResult(execResult!.messages, entityType) as Array<Record<string, unknown>>;
  const govMsg = govView[0];
  assert("id" in govMsg && "receivedDateTime" in govMsg && "isRead" in govMsg && "hasAttachments" in govMsg && "importance" in govMsg, "gov view keeps id + structural flags/timestamp");
  assert(!("subject" in govMsg), "gov view has NO subject (content withheld)");
  assert(!("bodyPreview" in govMsg), "gov view has NO bodyPreview (content withheld)");
  assert(!("from" in govMsg), "gov view has NO from (PII withheld)");
  const govJson = JSON.stringify(govView);
  assert(!govJson.includes("CUI"), "gov view leaks NO CUI content");
  assert(!govJson.includes("boss@acme.us"), "gov view leaks NO from-address PII");

  // And a m365_user gov view withholds displayName/mail.
  _resetGraphTokenCache();
  const userFetch = mockGraphFetch({ value: [{ id: "u1", accountEnabled: true, displayName: "Jane Doe", mail: "jane@acme.us", userPrincipalName: "jane@acme.us", jobTitle: "PM" }] });
  const usersRes = (await executeMicrosoft365Tool("m365_list_users", {}, { orgId: org.id, userId: "00000000-0000-0000-0000-0000000000bb", fetchImpl: userFetch })) as { users: Array<Record<string, unknown>> };
  const govUsers = projectResult(usersRes.users, entityTypeForTool("m365_list_users")) as Array<Record<string, unknown>>;
  assert(!("displayName" in govUsers[0]) && !("mail" in govUsers[0]), "gov m365_user view has NO displayName/mail (PII withheld)");
  assert(govUsers[0].id === "u1" && govUsers[0].accountEnabled === true, "gov m365_user view keeps id + accountEnabled");

  // Confirm the MOCK access token never appears in any executor/gate output.
  assert(!JSON.stringify(execResult).includes(MOCK_ACCESS_TOKEN) && !govJson.includes(MOCK_ACCESS_TOKEN), "the access token never appears in any executor/gate output");

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  await prisma.organization.delete({ where: { id: org.id } }); // cascades integration + cred
  await prisma.user.delete({ where: { id: installer.id } });

  console.log("\n=== M365 CONNECTOR ACCEPTANCE: ALL CHECKS PASSED ===");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("ACCEPTANCE FAILED:", e?.message ?? e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
