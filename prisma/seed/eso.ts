/**
 * ĒSO tenant seed — Pontis vertical slice (foundation Plan 6).
 *
 * Provisions the ĒSO Architecture + Design organization on a Pontis (or cosmos)
 * instance built from this image:
 *   • an OWNER admin who can sign in immediately (email + password — no OAuth needed),
 *   • AEC-only entitlements (matches the Pontis product profile),
 *   • the CRM "Lead Tracker" migrated from Maggie's Claude-built prototype
 *     (1 real seed lead + a small set of clearly-flagged example leads spanning
 *     the pipeline, plus the referral partner from the Referral Network prototype),
 *   • a per-user home dashboard for the principal (Maggie) and operations (Carli).
 *
 * The CRM is a single `CrmContact` model — a "pipeline" is contacts grouped by the
 * uppercase `stage`. Maggie's 7 statuses map onto the 6 canonical stages; her 8
 * sources / follow-up dates / project scope / referral linkage live in `customFields`
 * (there is no CRM custom-field registry to populate — it's a free-form JSON blob).
 *
 * Run from the cosmos-v2 checkout against a deployed DB (idempotent — every write
 * is an upsert / find-or-create, so it is safe to re-run):
 *
 *   DATABASE_URL=postgres://cosmos:PW@localhost:5433/cosmos \
 *     ESO_ADMIN_EMAIL=you@example.com ESO_ADMIN_PASSWORD='a-strong-password' \
 *     npx tsx prisma/seed/eso.ts
 *
 * Prereq: `npm run seed` has already run against the DB (the AEC built-ins live as
 * global `orgId: null` templates; the entitlement `enabledSectors: ['aec']` is what
 * scopes ĒSO to them).
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
// password.ts imports only node:crypto — no app-dependency chain, safe under tsx.
import { hashPassword, passwordPolicyError } from "../../src/lib/auth/password";

// ── Config (overridable via env) ───────────────────────────────────────────
const ORG_NAME = "ĒSO Architecture + Design";
const ORG_SLUG = "eso";
const ESO_TEAL = "#0F4761"; // ĒSO brand accent, layered over the atelier pearl canvas
const ADMIN_EMAIL = (process.env.ESO_ADMIN_EMAIL ?? "fightingsmartcyber@gmail.com").trim();
const ADMIN_NAME = process.env.ESO_ADMIN_NAME ?? "Maggie";
// Password login needs no allowlist; policy requires ≥12 chars. Printed at the end.
const ADMIN_PASSWORD = process.env.ESO_ADMIN_PASSWORD ?? "ChangeMe-ESO-2026";

// ── DB connection ──────────────────────────────────────────────────────────
// Prefer an explicit DATABASE_URL from the environment; otherwise fall back to a
// local .env.local (mirrors prisma/seed/demo-defense.ts) so a host run doesn't
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
const prisma = new PrismaClient(DB_URL ? { datasourceUrl: DB_URL } : undefined);

// ── Lead Tracker data ──────────────────────────────────────────────────────
// Maggie's 7 prototype statuses → the 6 canonical CRM stages. "On Hold" has no
// canonical equivalent; it folds to LEAD with the original preserved in
// customFields.sourceStatus.
const STAGE_FROM_STATUS: Record<string, string> = {
  New: "LEAD",
  Qualified: "QUALIFIED",
  "Proposal Sent": "PROPOSAL",
  Negotiation: "NEGOTIATION",
  Won: "CLOSED_WON",
  Lost: "CLOSED_LOST",
  "On Hold": "LEAD",
};

type LeadSeed = {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  status: keyof typeof STAGE_FROM_STATUS;
  value?: string; // dollars, numeric string → CrmContact.dealValue (Decimal)
  notes?: string;
  source: string; // one of Maggie's 8 sources
  scope?: string; // project type (free text in the prototype)
  address?: string;
  followUp?: string; // YYYY-MM-DD
  refPerson?: string; // referral network linkage (string match in the prototype)
  refNetwork?: string;
  example?: boolean; // illustrative row to replace with the real CSV export
};

// Row 1 is the actual record shipped in ESO_Lead_Tracker.html. Maggie's live
// leads persist only in her browser localStorage — export them via the app's
// "Export CSV" button and re-run with the real rows. Rows 2–5 are ESO-flavored
// examples spanning the pipeline so the board is demonstrable; flagged example:true.
const LEADS: LeadSeed[] = [
  {
    name: "Sean Russell",
    email: "sean.james.russell@gmail.com",
    status: "New",
    source: "Referral",
    scope: "New ADU",
    address: "4111 McBrine, Austin TX",
    notes: "Site meeting proposed.",
    refPerson: "Daniel Dodd",
    refNetwork: "Hudson Builders",
  },
  {
    name: "Olivia Chen",
    email: "olivia.chen@example.com",
    phone: "(512) 555-0142",
    status: "Qualified",
    source: "Past Client",
    scope: "New custom home",
    address: "Westlake Hills, Austin TX",
    value: "850000",
    followUp: "2026-06-22",
    notes: "Returning client — second residence. Wants a schematic-design fee proposal.",
    example: true,
  },
  {
    name: "Marcus Webb",
    company: "Webb Hospitality Group",
    email: "marcus@webbhg.com",
    phone: "(512) 555-0198",
    status: "Proposal Sent",
    source: "Website",
    scope: "Commercial tenant build-out",
    address: "E 6th St, Austin TX",
    value: "420000",
    followUp: "2026-06-19",
    notes: "Restaurant TI. Proposal sent 6/12 — follow up on scope of MEP coordination.",
    example: true,
  },
  {
    name: "The Alvarez Family",
    email: "alvarez.home@example.com",
    status: "Negotiation",
    source: "Referral",
    scope: "Kitchen + primary suite remodel",
    address: "Mueller, Austin TX",
    value: "280000",
    followUp: "2026-06-18",
    notes: "Negotiating phasing to fit budget. Decision expected end of month.",
    refPerson: "Olivia Chen",
    example: true,
  },
  {
    name: "Bennett Residence",
    email: "bennett.cd@example.com",
    status: "Won",
    source: "Past Client",
    scope: "New custom residence",
    address: "Tarrytown, Austin TX",
    value: "1650000",
    notes: "Signed AIA B101. Moving into CD set.",
    example: true,
  },
];

// The other half of Maggie's tooling (ESO_Referral_Network.html). cosmos CRM has a
// single contact model, so the referral partner is a CrmContact flagged via
// customFields.kind; it sits in the LEAD column on the board (no separate
// referral-network surface yet — a candidate future module).
const REFERRAL_PARTNERS = [
  {
    name: "Daniel Dodd",
    company: "Hudson Builders",
    title: "Builder",
    email: "daniel@hudsonbuilders.com",
    notes: "Quality-focused residential builder in Austin. Values design-forward thinking.",
    tier: "Active",
    role: "Builder",
    origin: "Referred Sean Russell for the McBrine ADU.",
  },
];

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
  if (policyError) throw new Error(`ESO_ADMIN_PASSWORD rejected: ${policyError}`);

  console.log(`\n🌉  Seeding ĒSO tenant → ${DB_URL ? new URL(DB_URL).host : "(env DATABASE_URL)"}\n`);

  // 1) Admin user (the principal's seat) — sign in with email + password.
  const admin = await findOrCreateUser(ADMIN_EMAIL, ADMIN_NAME);
  await prisma.user.update({
    where: { id: admin.id },
    data: { passwordHash: hashPassword(ADMIN_PASSWORD), passwordSetAt: new Date(), displayName: ADMIN_NAME },
  });
  // Allowlist the email too, so a later Google-OAuth setup also works.
  await prisma.allowedEmail.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: { email: ADMIN_EMAIL, addedBy: "eso-seed" },
  });
  console.log(`  ✓ admin user  ${ADMIN_EMAIL}  (${admin.id})`);

  // A second member so the team / "Team members" widget is realistic.
  const carli = await findOrCreateUser("carli@eso.studio", "Carli");
  console.log(`  ✓ ops user    carli@eso.studio  (${carli.id})`);

  // 2) Organization — COMMERCIAL (override the GOV default), AEC studio.
  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: { name: ORG_NAME, tenantClass: "COMMERCIAL", themePrimary: ESO_TEAL },
    create: {
      name: ORG_NAME,
      slug: ORG_SLUG,
      plan: "BUSINESS",
      tenantClass: "COMMERCIAL",
      themePrimary: ESO_TEAL,
    },
  });
  console.log(`  ✓ org         ${ORG_NAME}  /${ORG_SLUG}  (${org.id})`);

  // 3) Members — OWNER (principal) + ADMIN (ops). Role alone confers permissions
  //    (resolvePermissions OR-s RolePermissions[role]); leave `permissions` at 0.
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId: org.id, userId: admin.id } },
    update: { role: "OWNER" },
    create: { orgId: org.id, userId: admin.id, role: "OWNER" },
  });
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId: org.id, userId: carli.id } },
    update: { role: "ADMIN" },
    create: { orgId: org.id, userId: carli.id, role: "ADMIN" },
  });
  console.log(`  ✓ members     Maggie=OWNER, Carli=ADMIN`);

  // 4) Entitlements — AEC sector only; modules unrestricted (Pontis default).
  await prisma.orgEntitlements.upsert({
    where: { orgId: org.id },
    update: { sectorAllowlistEnabled: true, enabledSectors: ["aec"] },
    create: {
      orgId: org.id,
      moduleAllowlistEnabled: false,
      enabledModules: [],
      sectorAllowlistEnabled: true,
      enabledSectors: ["aec"],
    },
  });
  console.log(`  ✓ entitlement AEC sector only`);

  // 5) CRM — the migrated Lead Tracker.
  let made = 0;
  for (const l of LEADS) {
    const stage = STAGE_FROM_STATUS[l.status];
    const customFields: Record<string, unknown> = { source: l.source, sourceStatus: l.status };
    if (l.scope) customFields.projectScope = l.scope;
    if (l.address) customFields.address = l.address;
    if (l.followUp) customFields.followUpDate = l.followUp;
    if (l.refPerson) customFields.referredBy = l.refPerson;
    if (l.refNetwork) customFields.referralNetwork = l.refNetwork;
    if (l.example) customFields.example = true;
    const created = await upsertContact(org.id, admin.id, {
      name: l.name,
      email: l.email ?? null,
      phone: l.phone ?? null,
      company: l.company ?? l.refNetwork ?? null,
      title: l.title ?? null,
      stage,
      dealValue: l.value ? new Prisma.Decimal(l.value) : null,
      notes: l.notes ?? null,
      customFields: customFields as Prisma.InputJsonValue,
    } as Prisma.CrmContactCreateManyInput);
    if ("createdAt" in created) made++;
  }
  for (const p of REFERRAL_PARTNERS) {
    await upsertContact(org.id, admin.id, {
      name: p.name,
      email: p.email ?? null,
      company: p.company ?? null,
      title: p.title ?? null,
      stage: "LEAD",
      notes: p.notes ?? null,
      customFields: {
        kind: "referral-partner",
        tier: p.tier,
        role: p.role,
        origin: p.origin,
      } as Prisma.InputJsonValue,
    } as Prisma.CrmContactCreateManyInput);
  }
  const contactCount = await prisma.crmContact.count({ where: { orgId: org.id } });
  console.log(`  ✓ CRM         ${contactCount} contacts (${LEADS.length} leads + ${REFERRAL_PARTNERS.length} referral partner)`);

  // 6) Home dashboard — the five portfolio/members metric cards, per user.
  const WIDGETS = ["open_items", "in_progress_items", "completed_items", "overdue_items", "team_members"];
  for (const ownerId of [admin.id, carli.id]) {
    for (let i = 0; i < WIDGETS.length; i++) {
      await prisma.homeWidget.upsert({
        where: { orgId_ownerId_type: { orgId: org.id, ownerId, type: WIDGETS[i] } },
        update: { sortOrder: i },
        create: { orgId: org.id, ownerId, type: WIDGETS[i], sortOrder: i },
      });
    }
  }
  console.log(`  ✓ dashboard   ${WIDGETS.length} widgets × 2 users`);

  console.log(`\n✅  ĒSO tenant ready.\n`);
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
