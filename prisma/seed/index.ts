import { PrismaClient } from "@prisma/client";
import { seedCrossCuttingTypes } from "./shared/cross-cutting";
import { seedSoftwareSector } from "./sectors/software";
import { seedAec } from "./sectors/aec";
import { seedOps } from "./sectors/ops";
import { seedConsulting } from "./sectors/consulting";
import { seedManufacturing } from "./sectors/manufacturing";
import { seedEducation } from "./sectors/education";
import { seedEvent } from "./sectors/event";
import { migrateLegacyData } from "./migrate-legacy";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  console.log("Cross-cutting types:");
  await seedCrossCuttingTypes(prisma);

  console.log("Software sector:");
  await seedSoftwareSector(prisma);

  console.log("AEC sector:");
  await seedAec(prisma);

  console.log("IT Ops sector:");
  await seedOps(prisma);

  console.log("Consulting sector:");
  await seedConsulting(prisma);

  console.log("Manufacturing sector:");
  await seedManufacturing(prisma);

  console.log("Education sector:");
  await seedEducation(prisma);

  console.log("Event sector:");
  await seedEvent(prisma);

  console.log("\nMigrating legacy data...");
  await migrateLegacyData(prisma);

  // Print final counts
  const workItemTypeCount = await prisma.workItemType.count({ where: { orgId: null } });
  const boardTemplateCount = await prisma.boardTemplate.count({ where: { orgId: null } });
  const projectTemplateCount = await prisma.projectTemplate.count({ where: { orgId: null } });

  console.log("\nSeed complete:");
  console.log(`  WorkItemTypeModel (built-in): ${workItemTypeCount}`);
  console.log(`  BoardTemplate (built-in):     ${boardTemplateCount}`);
  console.log(`  ProjectTemplate (built-in):   ${projectTemplateCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
