import { describe, expect, it, beforeAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { seedBuiltinWorkRoles } from "./builtin-work-roles-seed";
import { BUILTIN_WORK_ROLES } from "./builtin-work-roles";
import { permissionMaskFromKeys } from "./permissions";

let orgId: string;
beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" }, select: { id: true } });
  orgId = org.id;
});

describe("seedBuiltinWorkRoles", () => {
  it("seeds all catalog entries idempotently", async () => {
    await seedBuiltinWorkRoles(orgId);
    await seedBuiltinWorkRoles(orgId); // second run must not duplicate
    const rows = await prisma.workRole.findMany({ where: { orgId, isBuiltIn: true } });
    expect(rows.length).toBe(BUILTIN_WORK_ROLES.length);
  });
  it("re-syncs drifted names/grants from the catalog", async () => {
    const pm = BUILTIN_WORK_ROLES[0];
    await prisma.workRole.update({ where: { orgId_key: { orgId, key: pm.key } }, data: { name: "Tampered", grants: 0n } });
    await seedBuiltinWorkRoles(orgId);
    const row = await prisma.workRole.findUniqueOrThrow({ where: { orgId_key: { orgId, key: pm.key } } });
    expect(row.name).toBe(pm.name);
    expect(row.grants).toBe(permissionMaskFromKeys(pm.permissions));
  });
});
