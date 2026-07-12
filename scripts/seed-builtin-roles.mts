// One-time/idempotent: seed the built-in work-role catalog into EVERY org.
// Run: DATABASE_URL=<target> npx tsx scripts/seed-builtin-roles.mts
import { prisma } from "@/lib/db/client";
import { seedBuiltinWorkRoles } from "@/lib/rbac/builtin-work-roles-seed";

const orgs = await prisma.organization.findMany({ select: { id: true, slug: true } });
for (const o of orgs) {
  await seedBuiltinWorkRoles(o.id);
  console.log(`seeded ${o.slug}`);
}
console.log(`done: ${orgs.length} orgs`);

// Backfill collision check: seedBuiltinWorkRoles upserts each catalog entry by
// { orgId, key } only — it never checks a new built-in's name against roles
// that already exist in that org (the POST /work-roles route's case-
// insensitive name-uniqueness check doesn't run here). If an org already had
// a custom role named e.g. "Analyst" before this seed, it now has two roles
// both named "Analyst" with no way for a member to tell them apart in the UI.
// Surface every such collision so an operator can rename the custom role.
// Exits 0 regardless — this is visibility, not a failure.
const dupes = await prisma.$queryRaw<{ org_id: string; name: string }[]>`
  SELECT org_id, lower(name) AS name
  FROM work_roles
  GROUP BY org_id, lower(name)
  HAVING count(*) > 1
`;
for (const d of dupes) {
  console.warn(`org ${d.org_id}: duplicate role name '${d.name}' — rename the custom role`);
}

process.exit(0);
