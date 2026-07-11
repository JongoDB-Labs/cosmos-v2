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
process.exit(0);
