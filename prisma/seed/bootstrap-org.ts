/**
 * Generic first-org bootstrap seed.
 *
 * Provisions a single organization on a fresh cosmos / Pontis instance built from
 * this image, plus an OWNER admin who can sign in immediately with email + password
 * (no OAuth required). Fully parameterized via environment variables — no product,
 * sector, or tenant specifics are baked in. Use this to stand up the first tenant
 * on a new deployment; per-vertical seeds (e.g. prisma/seed/eso.ts) layer on top.
 *
 * Every write is an upsert / find-or-create, so the script is idempotent and safe
 * to re-run (e.g. to rotate the admin password or add system-admin emails).
 *
 * Run from the cosmos-v2 checkout against a deployed DB:
 *
 *   DATABASE_URL=postgres://cosmos:PW@localhost:5433/cosmos \
 *     ORG_NAME='Acme Inc' ORG_SLUG=acme \
 *     ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-password' \
 *     npx tsx prisma/seed/bootstrap-org.ts
 *
 * Prereq: `npm run seed` has already run against the DB so the global
 * (orgId: null) built-in templates exist. This script does NOT seed templates.
 */
import { Prisma } from "@prisma/client";
import { makePrismaClient } from "./shared/prisma-client";
import { readFileSync } from "node:fs";
// password.ts imports only node:crypto — no app-dependency chain, safe under tsx.
import { hashPassword, passwordPolicyError } from "../../src/lib/auth/password";

// ── Config (all overridable via env) ─────────────────────────────────────────
const ORG_NAME = (process.env.ORG_NAME ?? "Acme Inc").trim();
const ORG_SLUG = (process.env.ORG_SLUG ?? "acme").trim();
// Plan enum: FREE | TEAM | BUSINESS | ENTERPRISE | GOV. Default BUSINESS.
const ORG_PLAN = (process.env.ORG_PLAN ?? "BUSINESS").trim();
// TenantClass enum: GOV | COMMERCIAL. Default COMMERCIAL (overrides the schema's
// GOV default, matching the common self-serve case).
const ORG_TENANT_CLASS = (process.env.ORG_TENANT_CLASS ?? "COMMERCIAL").trim();

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "admin@example.com").trim();
const ADMIN_NAME = process.env.ADMIN_NAME ?? "Admin";
// Password login needs no allowlist; policy requires ≥12 chars. Printed at the end.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "ChangeMe-Bootstrap-2026";

// Optional CSV of platform/INTERNAL_ADMINS emails to add to the AllowedEmail
// allowlist (so they can sign in / be promoted later). The admin above is always
// allowlisted regardless of this list.
const SYSTEM_ADMIN_EMAILS = (process.env.SYSTEM_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

// Optional: seed a tiny amount of generic mock CRM data (two "Sample Contact"
// rows) so the CRM surface isn't empty on first run. Off by default.
const SEED_MOCK = process.env.SEED_MOCK === "true";

// ── DB connection ──────────────────────────────────────────────────────────
// Prefer an explicit DATABASE_URL from the environment; otherwise fall back to a
// local .env.local (mirrors prisma/seed/eso.ts) so a host run doesn't grab .env's
// in-container `pontis-postgres` hostname.
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

async function findOrCreateUser(email: string, displayName: string) {
  const normalized = email.trim();
  // User.email is NOT unique — match case-insensitively, never blind-create.
  const existing = await prisma.user.findFirst({
    where: { email: { equals: normalized, mode: "insensitive" } },
  });
  if (existing) return existing;
  return prisma.user.create({ data: { email: normalized, displayName, avatarUrl: null } });
}

async function upsertContact(orgId: string, ownerId: string, c: Prisma.CrmContactCreateManyInput) {
  const existing = await prisma.crmContact.findFirst({ where: { orgId, name: c.name } });
  if (existing) return existing;
  return prisma.crmContact.create({ data: { ...c, orgId, ownerId } });
}

async function main() {
  const policyError = passwordPolicyError(ADMIN_PASSWORD);
  if (policyError) throw new Error(`ADMIN_PASSWORD rejected: ${policyError}`);

  console.log(`\n🌉  Bootstrapping org → ${DB_URL ? new URL(DB_URL).host : "(env DATABASE_URL)"}\n`);

  // 1) Admin user (the org owner's seat) — sign in with email + password.
  const admin = await findOrCreateUser(ADMIN_EMAIL, ADMIN_NAME);
  await prisma.user.update({
    where: { id: admin.id },
    data: { passwordHash: hashPassword(ADMIN_PASSWORD), passwordSetAt: new Date(), displayName: ADMIN_NAME },
  });
  // Allowlist the email too, so a later Google-OAuth setup also works.
  await prisma.allowedEmail.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: { email: ADMIN_EMAIL, addedBy: "bootstrap-org-seed" },
  });
  console.log(`  ✓ admin user  ${ADMIN_EMAIL}  (${admin.id})`);

  // 1b) System-admin allowlist (platform / INTERNAL_ADMINS), if provided.
  for (const email of SYSTEM_ADMIN_EMAILS) {
    await prisma.allowedEmail.upsert({
      where: { email },
      update: {},
      create: { email, addedBy: "bootstrap-org-seed" },
    });
  }
  if (SYSTEM_ADMIN_EMAILS.length) {
    console.log(`  ✓ allowlist   ${SYSTEM_ADMIN_EMAILS.length} system-admin email(s)`);
  }

  // 2) Organization — parameterized plan + tenant class.
  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: { name: ORG_NAME, tenantClass: ORG_TENANT_CLASS as Prisma.OrganizationUpdateInput["tenantClass"] },
    create: {
      name: ORG_NAME,
      slug: ORG_SLUG,
      plan: ORG_PLAN as Prisma.OrganizationCreateInput["plan"],
      tenantClass: ORG_TENANT_CLASS as Prisma.OrganizationCreateInput["tenantClass"],
    },
  });
  console.log(`  ✓ org         ${ORG_NAME}  /${ORG_SLUG}  (${org.id})`);

  // 3) Membership — OWNER. Role alone confers permissions (resolvePermissions
  //    OR-s RolePermissions[role]); leave `permissions` at its 0 default.
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId: org.id, userId: admin.id } },
    update: { role: "OWNER" },
    create: { orgId: org.id, userId: admin.id, role: "OWNER" },
  });
  console.log(`  ✓ member      ${ADMIN_NAME}=OWNER`);

  // 4) Optional generic mock CRM data — two clearly-labeled sample contacts.
  //    orgId + ownerId are injected by upsertContact (mirrors eso.ts), so the
  //    literals omit them and are cast to the create-many input shape.
  if (SEED_MOCK) {
    const SAMPLES = [
      { name: "Sample Contact 1", email: "sample1@example.com", stage: "LEAD", notes: "Example record — safe to delete." },
      { name: "Sample Contact 2", email: "sample2@example.com", stage: "QUALIFIED", notes: "Example record — safe to delete." },
    ];
    for (const c of SAMPLES) await upsertContact(org.id, admin.id, c as Prisma.CrmContactCreateManyInput);
    const contactCount = await prisma.crmContact.count({ where: { orgId: org.id } });
    console.log(`  ✓ mock CRM    ${contactCount} sample contact(s)`);
  }

  console.log(`\n✅  Org ready.\n`);
  console.log(`    Sign in at /${ORG_SLUG}  →  ${ADMIN_EMAIL}`);
  console.log(`    Password:  ${ADMIN_PASSWORD}   ← change after first sign-in\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
