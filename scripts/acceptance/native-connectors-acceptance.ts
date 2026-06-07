// Docker acceptance harness for the v2.20 native Jira + Slack connectors.
//
// Proves the connector MECHANICS end-to-end against a REAL Postgres (no real
// Jira/Slack — fetch is mocked to exercise dispatch + egress without a network):
//   1. INSTALL SEALS THE TOKEN — installs jira + slack via the SAME code the
//      install route uses (splitConfigSecrets → setOrgCredential + prisma.integration
//      .create). Asserts Integration.config has NO token, the sealed
//      connector_credentials rows exist as v2.<kid> envelopes, and getOrgCredential
//      returns the bundles.
//   2. DISPATCH ROUTES — executeTool('jira_search_issues' | 'slack_list_channels' …)
//      routes through the connector registry to the right executor (graceful
//      not-connected when the cred is absent; mocked-fetch success otherwise).
//   3. EGRESS GATING — a gov-tenant result is STRUCTURAL-ONLY (no summary/description/
//      text); a commercial-tenant result is FULL. Uses the REAL gate (projectForModel)
//      + projectResult, exactly as agent-loop.ts does.
//
// Run inside the acceptance container with DATABASE_URL + the vault keyring set.

import { prisma } from "../../src/lib/db/client";
// Importing the registry INDEX populates IntegrationRegistry from CATALOG (side effect).
import "../../src/lib/integrations/registry/index";
import { IntegrationRegistry } from "../../src/lib/integrations/registry";
import { splitConfigSecrets } from "../../src/lib/integrations/config-secrets";
import { setOrgCredential, getOrgCredential } from "../../src/lib/integrations/credentials";
import { executeTool } from "../../src/lib/ai/tool-executor";
import { projectForModel, projectResult, entityTypeForTool } from "../../src/lib/ai/egress";
import type { EgressContext, TenantClass } from "../../src/lib/ai/egress";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined && !ok ? `  →  ${JSON.stringify(detail)}` : ""}`);
}
function section(title: string) {
  console.log(`\n──────────────────────────────────────────────────────────\n${title}\n──────────────────────────────────────────────────────────`);
}

const JIRA_TOKEN = "JIRATEST";
const SLACK_TOKEN = "xoxb-TEST";

/** Replicate the install route's seal-split exactly (config-secrets → setOrgCredential). */
async function install(orgId: string, userId: string, providerSlug: string, config: Record<string, unknown>) {
  const provider = IntegrationRegistry.get(providerSlug);
  if (!provider) throw new Error(`provider ${providerSlug} not in registry`);
  const { publicConfig, secrets, hasSecrets } = splitConfigSecrets(provider, config);
  if (hasSecrets) await setOrgCredential(orgId, providerSlug, secrets);
  await prisma.integration.create({
    data: { orgId, provider: providerSlug, displayName: providerSlug, config: publicConfig as object, status: "ACTIVE", installedById: userId },
  });
  return { publicConfig, secretKeys: Object.keys(secrets) };
}

async function main() {
  // ── Fixtures: an org + an installing user (FKs for Integration/ConnectorCredential).
  const org = await prisma.organization.create({ data: { name: "Acceptance Org", slug: `accept-${Date.now()}` } });
  const user = await prisma.user.create({ data: { email: `accept-${Date.now()}@example.com`, displayName: "Acceptance" } });

  // ════════════════════════════════════════════════════════════════════════
  section("1. INSTALL SEALS THE TOKEN (jira + slack)");

  const jiraInstall = await install(org.id, user.id, "jira", {
    email: "bot@acme.com", apiToken: JIRA_TOKEN, baseUrl: "https://acme.atlassian.net", defaultProjectKey: "ABC",
  });
  const slackInstall = await install(org.id, user.id, "slack", {
    botToken: SLACK_TOKEN, defaultChannel: "C0DEFAULT",
  });

  // Catalog flip is real:
  check("catalog: jira is available/config/api_key", IntegrationRegistry.get("jira")?.status === "available" && IntegrationRegistry.get("jira")?.connect === "config");
  check("catalog: slack is available/config/api_key", IntegrationRegistry.get("slack")?.status === "available" && IntegrationRegistry.get("slack")?.connect === "config");

  // Integration.config has NO token (only non-secret fields).
  const jiraIntegration = await prisma.integration.findFirst({ where: { orgId: org.id, provider: "jira" }, select: { config: true } });
  const slackIntegration = await prisma.integration.findFirst({ where: { orgId: org.id, provider: "slack" }, select: { config: true } });
  const jiraConfigStr = JSON.stringify(jiraIntegration?.config ?? {});
  const slackConfigStr = JSON.stringify(slackIntegration?.config ?? {});
  check("jira Integration.config has NO apiToken value", !jiraConfigStr.includes(JIRA_TOKEN), jiraIntegration?.config);
  check("jira Integration.config DOES keep non-secret baseUrl/defaultProjectKey", jiraConfigStr.includes("acme.atlassian.net") && jiraConfigStr.includes("ABC"));
  check("slack Integration.config has NO botToken value", !slackConfigStr.includes(SLACK_TOKEN), slackIntegration?.config);
  check("slack Integration.config DOES keep non-secret defaultChannel", slackConfigStr.includes("C0DEFAULT"));
  check("install split sealed exactly the secret field(s) jira=[email,apiToken] slack=[botToken]",
    jiraInstall.secretKeys.sort().join(",") === "apiToken,email" && slackInstall.secretKeys.join(",") === "botToken",
    { jira: jiraInstall.secretKeys, slack: slackInstall.secretKeys });

  // Sealed connector_credentials rows exist as v2.<kid> envelopes (token NOT in plaintext).
  const credRows = await prisma.connectorCredential.findMany({ where: { orgId: org.id }, select: { provider: true, secretEnc: true, userId: true } });
  const jiraCred = credRows.find((r) => r.provider === "jira");
  const slackCred = credRows.find((r) => r.provider === "slack");
  check("sealed connector_credentials row exists for jira (org-level, userId null)", !!jiraCred && jiraCred.userId === null);
  check("sealed connector_credentials row exists for slack (org-level, userId null)", !!slackCred && slackCred.userId === null);
  check("jira secret_enc is a v2.<kid> AES-GCM envelope (NOT plaintext token)", !!jiraCred && jiraCred.secretEnc.startsWith("v2.") && !jiraCred.secretEnc.includes(JIRA_TOKEN), jiraCred?.secretEnc?.slice(0, 24));
  check("slack secret_enc is a v2.<kid> AES-GCM envelope (NOT plaintext token)", !!slackCred && slackCred.secretEnc.startsWith("v2.") && !slackCred.secretEnc.includes(SLACK_TOKEN), slackCred?.secretEnc?.slice(0, 24));

  // getOrgCredential unseals the bundles.
  const jiraBundle = await getOrgCredential(org.id, "jira");
  const slackBundle = await getOrgCredential(org.id, "slack");
  check("getOrgCredential('jira') returns { email, apiToken }", jiraBundle?.email === "bot@acme.com" && jiraBundle?.apiToken === JIRA_TOKEN);
  check("getOrgCredential('slack') returns { botToken }", slackBundle?.botToken === SLACK_TOKEN);

  // ════════════════════════════════════════════════════════════════════════
  section("2. DISPATCH ROUTES (executeTool → connector registry → executor)");

  // 2a. not-connected for a FRESH org with no creds installed → graceful error.
  const freshOrg = await prisma.organization.create({ data: { name: "Fresh", slug: `fresh-${Date.now()}` } });
  const jiraNC = (await executeTool("jira_search_issues", {}, { orgId: freshOrg.id, userId: user.id, tenantClass: "gov" })) as { error?: string };
  const slackNC = (await executeTool("slack_list_channels", {}, { orgId: freshOrg.id, userId: user.id, tenantClass: "gov" })) as { error?: string };
  check("jira_search_issues on a not-connected org → graceful 'Jira is not connected'", typeof jiraNC.error === "string" && jiraNC.error.includes("Jira is not connected"), jiraNC);
  check("slack_list_channels on a not-connected org → graceful 'Slack is not connected'", typeof slackNC.error === "string" && slackNC.error.includes("Slack is not connected"), slackNC);

  // 2b. mocked-fetch SUCCESS for the connected org — proves routing into the executor
  // AND the real HTTP shaping. We monkeypatch globalThis.fetch (the descriptor calls
  // the executor with the default fetch).
  const realFetch = globalThis.fetch;
  type FetchRes = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  const mockJson = (status: number, body: unknown): FetchRes => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  const jiraApiIssue = {
    key: "ABC-7",
    fields: {
      summary: "CUI//SP exfil path", description: "secret repro steps",
      status: { name: "In Progress" }, priority: { name: "High" }, issuetype: { name: "Bug" },
      assignee: { accountId: "acc-9", displayName: "Jane Doe" },
      created: "2026-06-01T00:00:00Z", updated: "2026-06-02T00:00:00Z", resolutiondate: null,
    },
  };
  const slackApiMessage = { ts: "1700000000.000100", channel: { id: "C123", name: "ops-secret" }, user: "U456", type: "message", text: "CUI//SP exfiltration plan" };

  // @ts-expect-error — test monkeypatch
  globalThis.fetch = async (url: string) => {
    const u = String(url);
    if (u.includes("/rest/api/3/search")) return mockJson(200, { issues: [jiraApiIssue] });
    if (u.includes("/api/conversations.list")) return mockJson(200, { ok: true, channels: [{ id: "C123", name: "ops-secret", is_private: true, is_archived: false, created: 1700000000 }] });
    if (u.includes("/api/search.messages")) return mockJson(200, { ok: true, messages: { matches: [slackApiMessage] } });
    throw new Error(`unexpected fetch in harness: ${u}`);
  };

  let jiraSearch: Record<string, unknown>;
  let slackSearch: Record<string, unknown>;
  try {
    jiraSearch = (await executeTool("jira_search_issues", {}, { orgId: org.id, userId: user.id, tenantClass: "commercial" })) as Record<string, unknown>;
    slackSearch = (await executeTool("slack_search_messages", { query: "exfil" }, { orgId: org.id, userId: user.id, tenantClass: "commercial" })) as Record<string, unknown>;
  } finally {
    globalThis.fetch = realFetch;
  }
  check("jira_search_issues (mocked) routed to the jira executor and returned an issue", Array.isArray(jiraSearch.issues) && (jiraSearch.issues as unknown[]).length === 1);
  check("slack_search_messages (mocked) routed to the slack executor and returned a message", Array.isArray(slackSearch.messages) && (slackSearch.messages as unknown[]).length === 1);

  // ════════════════════════════════════════════════════════════════════════
  section("3. EGRESS GATING (gov structural-only vs commercial full)");

  // Replicate agent-loop.ts: modelView = exposed ? full : projectResult(output, entity).
  function modelView(output: unknown, toolName: string, tenantClass: TenantClass): unknown {
    const ctx: EgressContext = { orgId: org.id, conversationId: "accept", turn: 1, tenantClass, mode: "enforced" };
    const projected = projectForModel(output, ctx, { valueKind: "tool_result", toolName, ceiling: "UNCLASSIFIED" });
    return projected.decision.exposed ? projected.modelValue : projectResult(output, entityTypeForTool(toolName));
  }

  // Single jira issue executor shape (what the model loop gates), built from the mocked result.
  const jiraIssue = (jiraSearch.issues as Record<string, unknown>[])[0];
  const slackMsg = (slackSearch.messages as Record<string, unknown>[])[0];

  // GOV — structural-only (this dataset carries a real CUI marking, so it ALSO trips
  // the marking-DLP tripwire that withholds for BOTH tenants — defense in depth).
  const jiraGov = modelView({ count: 1, issues: [jiraIssue] }, "jira_search_issues", "gov");
  const slackGov = modelView({ count: 1, messages: [slackMsg] }, "slack_search_messages", "gov");
  const jiraGovStr = JSON.stringify(jiraGov);
  const slackGovStr = JSON.stringify(slackGov);
  console.log("gov jira modelView:  ", jiraGovStr);
  console.log("gov slack modelView: ", slackGovStr);
  check("GOV jira: structural fields present (key/status/priority/issueType)", jiraGovStr.includes("ABC-7") && jiraGovStr.includes("In Progress") && jiraGovStr.includes("Bug"));
  check("GOV jira: summary/description WITHHELD (no CUI content)", !jiraGovStr.includes("CUI") && !jiraGovStr.includes("secret") && !jiraGovStr.includes("exfil") && !jiraGovStr.includes("Jane Doe"));
  check("GOV slack: structural fields present (ts/channel/user/type)", slackGovStr.includes("1700000000.000100") && slackGovStr.includes("C123") && slackGovStr.includes("U456"));
  check("GOV slack: message text WITHHELD (no CUI content)", !slackGovStr.includes("text") && !slackGovStr.includes("CUI") && !slackGovStr.includes("exfiltration"));

  // COMMERCIAL vs GOV on NON-marked content — isolates the TENANT-CLASS egress decision
  // from the marking tripwire. Commercial sees the FULL value; gov still gets the
  // structural-only projection (default-deny by tenant).
  const jiraIssuePlain = { key: "DEF-2", summary: "Quarterly report formatting", description: "fix table widths", status: "Done", priority: "Low", issueType: "Task", assigneeAccountId: "acc-x", created: "2026-05-01T00:00:00Z", updated: "2026-05-02T00:00:00Z", resolutiondate: "2026-05-03T00:00:00Z" };
  const slackMsgPlain = { ts: "1700000111.000100", channel: "C999", user: "U111", type: "message", text: "standup at 10am please" };

  const jiraComm = modelView({ count: 1, issues: [jiraIssuePlain] }, "jira_search_issues", "commercial");
  const slackComm = modelView({ count: 1, messages: [slackMsgPlain] }, "slack_search_messages", "commercial");
  const jiraCommStr = JSON.stringify(jiraComm);
  const slackCommStr = JSON.stringify(slackComm);
  console.log("commercial jira modelView: ", jiraCommStr);
  console.log("commercial slack modelView:", slackCommStr);
  check("COMMERCIAL jira: FULL value (summary/description present)", jiraCommStr.includes("Quarterly report formatting") && jiraCommStr.includes("fix table widths"));
  check("COMMERCIAL slack: FULL value (message text present)", slackCommStr.includes("standup at 10am please"));

  // And GOV on the SAME non-marked content is STILL structural-only (tenant default-deny).
  const jiraGovPlain = JSON.stringify(modelView({ count: 1, issues: [jiraIssuePlain] }, "jira_search_issues", "gov"));
  const slackGovPlain = JSON.stringify(modelView({ count: 1, messages: [slackMsgPlain] }, "slack_search_messages", "gov"));
  check("GOV jira (non-marked): STILL structural-only (summary withheld by tenant default-deny)", jiraGovPlain.includes("DEF-2") && !jiraGovPlain.includes("Quarterly"));
  check("GOV slack (non-marked): STILL structural-only (text withheld by tenant default-deny)", slackGovPlain.includes("C999") && !slackGovPlain.includes("standup"));

  // ── Teardown the fixtures (cascade removes integrations + creds).
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.organization.delete({ where: { id: freshOrg.id } });
  await prisma.user.delete({ where: { id: user.id } });

  section(`RESULT: ${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("HARNESS ERROR:", err);
  await prisma.$disconnect();
  process.exit(1);
});
