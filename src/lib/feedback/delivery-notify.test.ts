import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { notifyDeliveryEvent } from "./delivery-notify";

/** e2e-DB test against an ISOLATED throwaway org per fixture — the shared
 *  test-org's settings are mutated by other parallel feedback suites
 *  (remediate.test.ts), so touching them here would race. */
describe("notifyDeliveryEvent (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };

  afterAll(async () => {
    // Org delete cascades members/projects/work items/notifications.
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function fixture(notify: { parked: boolean; shipped: boolean }) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: {
        name: `notify-test ${stamp}`,
        slug: `notify-test-${stamp}`,
        settings: { autonomousDelivery: { enabled: true, projectIds: [], notify } },
      },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const project = await prisma.project.create({
      data: { orgId: org.id, name: "P", key: `NT${stamp.slice(-4).toUpperCase()}` },
    });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    const wi = await prisma.workItem.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        ticketNumber: 1,
        title: `notify fixture ${stamp}`,
        description: "",
        columnKey: "review",
        workItemTypeId: type.id,
        createdById: owner.id,
      },
    });
    return { org, wi, ownerId: owner.id };
  }

  it("notifies every org OWNER on a parked event, with a deep link", async () => {
    const { org, wi } = await fixture({ parked: true, shipped: true });
    await notifyDeliveryEvent(org.id, "parked", {
      key: "TEST-999",
      title: "some change",
      reason: "checks failed",
      version: "9.9.9",
      workItemId: wi.id,
    });
    const notifs = await prisma.notification.findMany({ where: { orgId: org.id, refId: wi.id } });
    expect(notifs.length).toBe(1); // exactly the one OWNER
    expect(notifs[0].type).toBe("delivery.parked");
    expect(notifs[0].title).toContain("TEST-999");
    expect(notifs[0].url).toContain(wi.id);
    expect(notifs[0].body).toContain("checks failed");
  });

  it("honors the per-event toggle: shipped=false ⇒ no notification", async () => {
    const { org, wi } = await fixture({ parked: true, shipped: false });
    await notifyDeliveryEvent(org.id, "shipped", { key: "TEST-998", title: "t", version: "1.0.0", workItemId: wi.id });
    const notifs = await prisma.notification.findMany({ where: { orgId: org.id, refId: wi.id } });
    expect(notifs.length).toBe(0);
  });

  it("shipped event fires when enabled", async () => {
    const { org, wi } = await fixture({ parked: false, shipped: true });
    await notifyDeliveryEvent(org.id, "shipped", { key: "TEST-997", title: "t", version: "1.2.3", workItemId: wi.id });
    const notifs = await prisma.notification.findMany({ where: { orgId: org.id, refId: wi.id } });
    expect(notifs.length).toBe(1);
    expect(notifs[0].type).toBe("delivery.shipped");
    expect(notifs[0].title).toContain("v1.2.3");
  });

  it("never throws on an unknown org", async () => {
    await expect(
      notifyDeliveryEvent("00000000-0000-0000-0000-000000000000", "shipped", { key: "X-1", title: "t", workItemId: "00000000-0000-0000-0000-000000000000" }),
    ).resolves.toBeUndefined();
  });
});
