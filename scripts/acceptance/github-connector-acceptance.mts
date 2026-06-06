/**
 * Docker acceptance harness for the GitHub connector slice (run inside the migrate
 * image via tsx, joined to the compose network). It exercises the REAL production
 * code paths — splitConfigSecrets + setOrgCredential/getOrgCredential + the vault —
 * against the live Postgres, with the same SSO_VAULT_KEY the app uses. NO real
 * GitHub token: GHTESTTOK is a placeholder; we prove the SEAL mechanics, not a live API.
 *
 * Proves:
 *   1. install seals the token: Integration.config has NO token (only defaultOwner/
 *      defaultRepo); a connector_credentials row (provider=github, user_id IS NULL,
 *      secret_enc = v2.<kid>.… envelope) exists; getOrgCredential returns the token.
 *   2. org-level + per-user coexist for the same (org, provider) — partial indexes.
 *   3. egress gating: a gov github tool result is structural-only (number/state, NO
 *      title/body) via the REAL projection contract.
 *   4. uninstall deletes the org credential (deleteOrgCredential).
 */
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import { IntegrationRegistry } from "@/lib/integrations/registry";
import { CATALOG } from "@/lib/integrations/registry/catalog.generated";
import { splitConfigSecrets } from "@/lib/integrations/config-secrets";
import {
  setOrgCredential,
  getOrgCredential,
  setCredential,
  deleteOrgCredential,
} from "@/lib/integrations/credentials";
import { kidOf } from "@/lib/crypto/vault";
import { projectResult, entityTypeForTool } from "@/lib/ai/egress/projection";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  PASS  ${msg}`);
}

async function main() {
  // Register the catalog (the install route does this via the
  // `import "@/lib/integrations/registry/index"` side-effect; we register
  // explicitly here so the harness doesn't depend on ESM side-effect ordering).
  for (const p of CATALOG) IntegrationRegistry.register(p);

  const ORG_SLUG = "acceptance-github-org";
  const USER_ID = "00000000-0000-0000-0000-0000000000bb";

  // Clean any prior run.
  await prisma.organization.deleteMany({ where: { slug: ORG_SLUG } });

  const org = await prisma.organization.create({
    data: { name: "Acceptance GitHub Org", slug: ORG_SLUG, tenantClass: "GOV" },
  });
  console.log(`\n[setup] gov org ${org.id} (tenantClass=GOV)\n`);

  // ── 1. INSTALL SEALS THE TOKEN ───────────────────────────────────────────
  console.log("[1] install seals the token (mirrors POST /integrations)");
  const provider = IntegrationRegistry.get("github");
  assert(provider, "github is registered in the catalog");
  assert(provider!.status === "available", "github status=available");
  assert(provider!.connect === "config", "github connect=config");
  assert(provider!.authType === "api_key", "github authType=api_key");

  const submitted = { token: "GHTESTTOK", defaultOwner: "acme", defaultRepo: "cosmos" };
  const { publicConfig, secrets, hasSecrets } = splitConfigSecrets(provider, submitted);
  assert(hasSecrets, "split detected a secret field");
  assert(secrets.token === "GHTESTTOK", "token routed to secrets bundle");
  assert(!("token" in publicConfig), "token is NOT in publicConfig");
  assert(
    JSON.stringify(publicConfig) === JSON.stringify({ defaultOwner: "acme", defaultRepo: "cosmos" }),
    "publicConfig holds only defaultOwner/defaultRepo",
  );

  if (hasSecrets) await setOrgCredential(org.id, "github", secrets);
  const integration = await prisma.integration.create({
    data: {
      orgId: org.id,
      provider: "github",
      displayName: "GitHub",
      config: publicConfig as Prisma.InputJsonValue,
      status: "ACTIVE",
      installedById: USER_ID,
    },
  });

  // Integration.config in the DB must NOT contain the token.
  const storedConfig = JSON.stringify(integration.config);
  console.log(`  Integration.config (DB) = ${storedConfig}`);
  assert(!storedConfig.includes("GHTESTTOK"), "Integration.config (DB) does NOT contain GHTESTTOK");
  assert(storedConfig.includes("defaultOwner") && storedConfig.includes("acme"), "Integration.config keeps defaultOwner");

  // A sealed org-level connector_credentials row must exist.
  const rows = await prisma.$queryRawUnsafe<Array<{ user_id: string | null; secret_enc: string }>>(
    `SELECT user_id, secret_enc FROM connector_credentials WHERE org_id = $1::uuid AND provider = 'github'`,
    org.id,
  );
  const orgRow = rows.find((r) => r.user_id === null);
  assert(orgRow, "a connector_credentials row with user_id IS NULL exists");
  console.log(`  secret_enc envelope     = ${orgRow!.secret_enc.slice(0, 24)}…  (kid=${kidOf(orgRow!.secret_enc)})`);
  assert(orgRow!.secret_enc.startsWith("v2."), "secret_enc is a v2.<kid>.… vault envelope");
  assert(!orgRow!.secret_enc.includes("GHTESTTOK"), "secret_enc envelope does NOT contain the plaintext token");

  // getOrgCredential opens it back to the bundle.
  const opened = await getOrgCredential(org.id, "github");
  assert(opened && opened.token === "GHTESTTOK", "getOrgCredential returns { token: 'GHTESTTOK' }");

  // ── 2. ORG-LEVEL + PER-USER COEXIST ──────────────────────────────────────
  console.log("\n[2] org-level + per-user creds coexist for the same (org, provider)");
  await setCredential(org.id, "github", USER_ID, { token: "USERTOK" });
  const allRows = await prisma.connectorCredential.findMany({
    where: { orgId: org.id, provider: "github" },
    select: { userId: true },
  });
  assert(allRows.length === 2, "two rows exist (one org-level, one per-user)");
  assert(allRows.some((r) => r.userId === null), "the org-level (NULL userId) row is present");
  assert(allRows.some((r) => r.userId === USER_ID), "the per-user row is present");
  const orgStill = await getOrgCredential(org.id, "github");
  assert(orgStill && orgStill.token === "GHTESTTOK", "org-level cred unchanged by the per-user write (no collision)");

  // ── 3. EGRESS GATING (gov sees structural-only) ──────────────────────────
  console.log("\n[3] egress gating: a gov github result is structural-only (REAL projection)");
  // The exact shape githubListIssues returns; projectResult is what the agent loop
  // applies on WITHHOLD (gov data → withheld → structural projection).
  const issuesResult = {
    success: true,
    count: 1,
    issues: [
      {
        number: 42,
        state: "open",
        title: "CUI//SP exfil path in sensor fusion",
        labels: ["bug", "CUI"],
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-02T00:00:00Z",
        closedAt: null,
      },
    ],
  };
  const entity = entityTypeForTool("github_list_issues");
  assert(entity === "github_issue", "github_list_issues maps to github_issue entity");
  const gov = projectResult(issuesResult, entity) as { count: number; issues: Array<Record<string, unknown>> };
  console.log(`  gov modelView           = ${JSON.stringify(gov)}`);
  assert(gov.issues[0].number === 42 && gov.issues[0].state === "open", "gov sees issue number + state");
  assert(!("title" in gov.issues[0]), "gov does NOT see the title (content withheld)");
  assert(!("labels" in gov.issues[0]), "gov does NOT see labels (array dropped)");
  assert(!JSON.stringify(gov).includes("CUI"), "no CUI marking survives into the gov modelView");
  assert(!JSON.stringify(gov).includes("exfil"), "no issue-title content survives into the gov modelView");

  // ── 4. UNINSTALL DELETES THE ORG CREDENTIAL ──────────────────────────────
  console.log("\n[4] uninstall deletes the org credential (deleteOrgCredential)");
  await deleteOrgCredential(org.id, "github");
  const afterDelete = await getOrgCredential(org.id, "github");
  assert(afterDelete === null, "getOrgCredential returns null after uninstall");
  const perUserAfter = await prisma.connectorCredential.findFirst({
    where: { orgId: org.id, provider: "github", userId: USER_ID },
  });
  assert(perUserAfter, "the per-user row is NOT deleted by an org-level uninstall");

  // Cleanup.
  await prisma.organization.delete({ where: { id: org.id } });
  console.log("\n[cleanup] test org removed.");
  console.log("\nALL ACCEPTANCE CHECKS PASSED ✅\n");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(`\n${err.message}\n`);
    await prisma.$disconnect();
    process.exit(1);
  });
