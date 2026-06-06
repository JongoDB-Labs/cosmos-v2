/**
 * Seed for the SSO OIDC round-trip acceptance. Creates a test Organization
 * (slug "dextest", GOV) + an IdpConnection pointing at the throwaway dex IdP,
 * with the dex client secret sealed via the vault. Idempotent: re-running
 * upserts the org + replaces the connection.
 *
 * Run inside the migrate image (has the prisma client + tsx + DIRECT_URL owner
 * creds), e.g.:
 *   docker compose ... run --rm -e SSO_VAULT_KEY=... cosmos-migrate \
 *     node_modules/.bin/tsx docs/sso-acceptance/seed.ts
 *
 * Contains NO secret literals beyond the throwaway dex client secret, which is
 * already in the (gitignored) dex config — this file is safe to commit.
 */
import { PrismaClient } from "@prisma/client";
import { sealSecret } from "../../src/lib/crypto/vault";

const ISSUER = process.env.DEX_ISSUER ?? "http://dex:5556/dex";
const CLIENT_ID = process.env.DEX_CLIENT_ID ?? "cosmos-acceptance";
const CLIENT_SECRET = process.env.DEX_CLIENT_SECRET ?? "dex-cosmos-throwaway-secret";
const SLUG = process.env.TEST_ORG_SLUG ?? "dextest";

async function main() {
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.upsert({
      where: { slug: SLUG },
      update: {},
      create: { name: "Dex Acceptance Org", slug: SLUG, tenantClass: "GOV" },
      select: { id: true, slug: true, tenantClass: true },
    });

    const clientSecretEnc = sealSecret(CLIENT_SECRET);

    // One IdpConnection per org (@@unique([orgId])) — upsert by orgId.
    const conn = await prisma.idpConnection.upsert({
      where: { orgId: org.id },
      update: {
        issuerUrl: ISSUER,
        clientId: CLIENT_ID,
        clientSecretEnc,
        enabled: true,
        enforced: false,
        jitProvisioning: true,
        requiredAcr: null,
      },
      create: {
        orgId: org.id,
        issuerUrl: ISSUER,
        clientId: CLIENT_ID,
        clientSecretEnc,
        enabled: true,
        enforced: false,
        jitProvisioning: true,
        requiredAcr: null,
      },
      select: { id: true, issuerUrl: true, enabled: true },
    });

    console.log(
      JSON.stringify(
        { ok: true, org, idpConnection: conn },
        null,
        2,
      ),
    );
  } finally {
    // no-op
  }
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
