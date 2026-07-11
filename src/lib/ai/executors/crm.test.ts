import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { createCrmContact, updateCrmContact, listPartners, listProducts } from "./crm";
import type { ToolContext } from "./_ctx";

const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("crm executors (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `crm-test ${stamp}`, slug: `crm-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    const denyCtx: ToolContext = { orgId: org.id, userId: NON_MEMBER };
    return { org, ctx, denyCtx };
  }

  it("create_crm_contact persists a contact and case-folds the stage", async () => {
    const { ctx } = await makeOrg();
    const res = (await createCrmContact({ name: "Acme Corp", stage: "qualified", dealValue: 1000 }, ctx)) as {
      created: boolean;
      id: string;
    };
    expect(res.created).toBe(true);
    const row = await prisma.crmContact.findUnique({ where: { id: res.id } });
    expect(row?.name).toBe("Acme Corp");
    expect(row?.stage).toBe("QUALIFIED"); // crmStageSchema upper-cases
  });

  it("create defaults stage to LEAD; update changes it", async () => {
    const { ctx } = await makeOrg();
    const created = (await createCrmContact({ name: "Widgets Inc" }, ctx)) as { id: string };
    expect((await prisma.crmContact.findUnique({ where: { id: created.id } }))?.stage).toBe("LEAD");

    const upd = (await updateCrmContact({ contactId: created.id, stage: "PROPOSAL" }, ctx)) as { updated: boolean };
    expect(upd.updated).toBe(true);
    expect((await prisma.crmContact.findUnique({ where: { id: created.id } }))?.stage).toBe("PROPOSAL");
  });

  it("list_partners / list_products round-trip org-scoped rows", async () => {
    const { ctx, org } = await makeOrg();
    await prisma.partner.create({ data: { orgId: org.id, name: "Sub LLC", type: "vendor", status: "active" } });
    await prisma.product.create({ data: { orgId: org.id, name: "Widget", status: "active" } });
    const partners = (await listPartners({}, ctx)) as { count: number };
    const products = (await listProducts({}, ctx)) as { count: number };
    expect(partners.count).toBe(1);
    expect(products.count).toBe(1);
  });

  it("denies a non-member (no CRM_* permission)", async () => {
    const { denyCtx } = await makeOrg();
    expect(await createCrmContact({ name: "x" }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await updateCrmContact({ contactId: NON_MEMBER }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await listPartners({}, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await listProducts({}, denyCtx)).toEqual({ error: "Insufficient permissions" });
  });
});
