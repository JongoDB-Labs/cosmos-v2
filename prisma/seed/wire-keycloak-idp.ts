/**
 * Wire a Keycloak OIDC IdP onto an EXISTING org — adds "Sign in with Keycloak".
 *
 * Attaches (or updates) the single `IdpConnection` for an org that already exists
 * (e.g. one stood up by prisma/seed/bootstrap-org.ts), pointing it at a Keycloak
 * realm's OIDC discovery base. The Keycloak client secret is sealed with the
 * crypto/vault keyring before it touches the DB — the plaintext never lands in a
 * column. Fully parameterized via environment variables — no realm, client, or
 * tenant specifics are baked in.
 *
 * Idempotent: the IdpConnection is upserted on `orgId` (the @@unique([orgId])
 * one-IdP-per-org constraint), so re-running rotates the client secret / refreshes
 * the issuer + scopes in place. The org itself is only looked up — never created
 * (run bootstrap-org.ts / eso.ts first).
 *
 * Run from the cosmos-v2 checkout against a deployed DB. The vault key the secret
 * is sealed under comes from SSO_VAULT_KEYS + SSO_VAULT_ACTIVE_KID (keyring) or the
 * legacy single SSO_VAULT_KEY — see src/lib/crypto/vault.ts:
 *
 *   DATABASE_URL=postgres://cosmos:PW@localhost:5433/cosmos \
 *     SSO_VAULT_KEY="$(openssl rand -base64 32)" \
 *     ORG_SLUG=acme \
 *     ISSUER_URL=https://sso.uds.dev/realms/uds \
 *     CLIENT_ID=cosmos CLIENT_SECRET='the-keycloak-client-secret' \
 *     node_modules/.bin/tsx prisma/seed/wire-keycloak-idp.ts
 *
 * Prereq: the org (ORG_SLUG) already exists. This script does NOT create orgs,
 * users, or seed templates.
 */
import { makePrismaClient } from "./shared/prisma-client";
import { readFileSync } from "node:fs";
// vault.ts imports only node:crypto — no app-dependency chain, safe under tsx.
import { sealSecret } from "../../src/lib/crypto/vault";

// ── Config (all overridable via env) ─────────────────────────────────────────
// The existing org to wire (looked up by slug — never created here).
const ORG_SLUG = (process.env.ORG_SLUG ?? "acme").trim();
// Keycloak realm OIDC discovery base, e.g. https://sso.uds.dev/realms/uds
const ISSUER_URL = (process.env.ISSUER_URL ?? "").trim();
// The OIDC client registered in Keycloak for this org.
const CLIENT_ID = (process.env.CLIENT_ID ?? "").trim();
// Plaintext client secret — sealed via sealSecret() before it touches the DB.
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? "";

// Optional CSV of OIDC scopes; defaults to the OIDC baseline.
const SCOPES = (process.env.SCOPES ?? "openid,email,profile")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// JIT-provision a user on first successful sign-in (default on).
const JIT = process.env.JIT !== "false";
// OrgRole enum: OWNER | ADMIN | BILLING_ADMIN | MEMBER | VIEWER | GUEST. Default MEMBER.
const DEFAULT_ROLE = (process.env.DEFAULT_ROLE ?? "MEMBER").trim();

// ── DB connection ──────────────────────────────────────────────────────────
// Prefer an explicit DATABASE_URL from the environment; otherwise fall back to a
// local .env.local (mirrors prisma/seed/bootstrap-org.ts) so a host run doesn't
// grab .env's in-container `pontis-postgres` hostname.
function resolveDbUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const txt = readFileSync(process.cwd() + "/.env.local", "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch {
    /* no .env.local — rely on a preset DATABASE_URL */
  }
  return process.env.DATABASE_URL;
}
const DB_URL = resolveDbUrl();
const prisma = makePrismaClient(DB_URL);

async function main() {
  // Validate required inputs up front (the secret is sealed, so a clear error here
  // beats an opaque crypto/DB failure later).
  if (!ISSUER_URL) throw new Error("ISSUER_URL is required (the Keycloak realm OIDC base, e.g. https://sso.uds.dev/realms/uds).");
  if (!CLIENT_ID) throw new Error("CLIENT_ID is required (the OIDC client registered in Keycloak).");
  if (!CLIENT_SECRET) throw new Error("CLIENT_SECRET is required (the Keycloak client's plaintext secret — it is sealed before storage).");

  console.log(`\n🌉  Wiring Keycloak IdP → ${DB_URL ? new URL(DB_URL).host : "(env DATABASE_URL)"}\n`);

  // 1) Look up the EXISTING org by slug — never create it here.
  const org = await prisma.organization.findUnique({
    where: { slug: ORG_SLUG },
    select: { id: true, slug: true, name: true },
  });
  if (!org) {
    throw new Error(
      `Org "${ORG_SLUG}" not found. Stand it up first (e.g. ORG_SLUG=${ORG_SLUG} npx tsx prisma/seed/bootstrap-org.ts), then re-run.`,
    );
  }
  console.log(`  ✓ org         ${org.name}  /${org.slug}  (${org.id})`);

  // 2) Seal the plaintext client secret under the active vault kid (crypto/vault).
  const clientSecretEnc = sealSecret(CLIENT_SECRET);
  console.log(`  ✓ secret      sealed (${clientSecretEnc.split(".")[0]}.${clientSecretEnc.split(".")[1] ?? ""})`);

  // 3) IdpConnection — one per org (@@unique([orgId])), upsert by orgId so this is
  //    idempotent / a re-run rotates the secret + refreshes issuer/scopes in place.
  const conn = await prisma.idpConnection.upsert({
    where: { orgId: org.id },
    update: {
      protocol: "OIDC",
      issuerUrl: ISSUER_URL,
      clientId: CLIENT_ID,
      clientSecretEnc,
      scopes: SCOPES,
      jitProvisioning: JIT,
      defaultRole: DEFAULT_ROLE as Parameters<typeof prisma.idpConnection.upsert>[0]["update"]["defaultRole"],
      enabled: true,
    },
    create: {
      orgId: org.id,
      protocol: "OIDC",
      issuerUrl: ISSUER_URL,
      clientId: CLIENT_ID,
      clientSecretEnc,
      scopes: SCOPES,
      jitProvisioning: JIT,
      defaultRole: DEFAULT_ROLE as Parameters<typeof prisma.idpConnection.upsert>[0]["create"]["defaultRole"],
      enabled: true,
    },
    select: { id: true, issuerUrl: true, clientId: true, scopes: true, jitProvisioning: true, defaultRole: true, enabled: true },
  });
  console.log(`  ✓ idp         OIDC  ${conn.clientId}  scopes=[${conn.scopes.join(", ")}]  jit=${conn.jitProvisioning}  defaultRole=${conn.defaultRole}  (${conn.id})`);

  console.log(`\n✅  Keycloak IdP wired.\n`);
  console.log(`    org      /${org.slug}`);
  console.log(`    issuer   ${conn.issuerUrl}`);
  console.log(`    clientId ${conn.clientId}`);
  console.log(`    enabled — Sign in with Keycloak at /${org.slug}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
