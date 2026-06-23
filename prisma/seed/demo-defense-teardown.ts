/**
 * Remove the "Apex Defense Systems" demo / walkthrough tenant and all its data.
 *
 *   tsx prisma/seed/demo-defense-teardown.ts            # delete the demo org
 *   tsx prisma/seed/demo-defense-teardown.ts --dry-run  # show what would go
 *
 * Deleting the org cascades to every org-scoped row (projects, boards, work
 * items, roadmap nodes, compliance, finance, …). The REAL owner account is kept;
 * only the demo *.local personas with no other membership are pruned. Idempotent:
 * a no-op if the demo org is already gone. Run "npm run seed:demo" to recreate it.
 */
import { makePrismaClient } from "./shared/prisma-client";
import { readFileSync } from "node:fs";

const SLUG = "apex-defense";

function loadEnvLocal(): string | undefined {
  let dbUrl: string | undefined;
  try {
    const txt = readFileSync(process.cwd() + "/.env.local", "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
      if (m[1] === "DATABASE_URL") dbUrl = v;
    }
  } catch {
    /* ignore */
  }
  return dbUrl;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const dbUrl = process.env.DATABASE_URL || loadEnvLocal();
  const prisma = makePrismaClient(dbUrl);

  try {
    const org = await prisma.organization.findUnique({
      where: { slug: SLUG },
      select: { id: true, name: true },
    });
    if (!org) {
      console.log(`[teardown] No demo org "${SLUG}" — nothing to do.`);
      return;
    }

    const [projects, items, nodes] = await Promise.all([
      prisma.project.count({ where: { orgId: org.id } }),
      prisma.workItem.count({ where: { orgId: org.id } }),
      prisma.roadmapNode.count({ where: { orgId: org.id } }),
    ]);
    console.log(
      `[teardown] "${org.name}" (${SLUG}): ${projects} projects, ${items} work items, ${nodes} roadmap nodes.`,
    );

    if (dryRun) {
      console.log("[teardown] --dry-run: no changes made.");
      return;
    }

    // Candidate demo personas (created by the seed); pruned only if this org was
    // their sole membership.
    const demoMemberUserIds = (
      await prisma.orgMember.findMany({ where: { orgId: org.id }, select: { userId: true } })
    ).map((m) => m.userId);

    await prisma.organization.delete({ where: { id: org.id } }); // cascades org-scoped rows

    let prunedUsers = 0;
    for (const userId of demoMemberUserIds) {
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, _count: { select: { memberships: true } } },
      });
      if (u && u.email.endsWith("@apex-defense.local") && u._count.memberships === 0) {
        await prisma.user.delete({ where: { id: userId } });
        prunedUsers++;
      }
    }

    console.log(`[teardown] Removed demo org + cascaded data; pruned ${prunedUsers} demo personas.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
