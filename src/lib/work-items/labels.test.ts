import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { normalizeLabelNames, resolveLabels, setWorkItemLabels } from "./labels";

describe("normalizeLabelNames", () => {
  it("trims, drops blanks, and folds case-variants to the first spelling seen", () => {
    expect(normalizeLabelNames([" Security ", "security", "SECURITY"])).toEqual([
      "Security",
    ]);
    expect(normalizeLabelNames(["a", "", "   ", "b"])).toEqual(["a", "b"]);
    expect(normalizeLabelNames([])).toEqual([]);
  });
});

describe("work-item labels (e2e DB)", () => {
  const created: { workItemIds: string[]; labelIds: string[] } = {
    workItemIds: [],
    labelIds: [],
  };

  afterAll(async () => {
    await prisma.workItem
      .deleteMany({ where: { id: { in: created.workItemIds } } })
      .catch(() => undefined);
    await prisma.label
      .deleteMany({ where: { id: { in: created.labelIds } } })
      .catch(() => undefined);
  });

  async function makeItem() {
    const org = await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" } });
    const project = await prisma.project.findFirstOrThrow({ where: { orgId: org.id } });
    const type = await prisma.workItemType.findFirstOrThrow({
      where: { OR: [{ orgId: org.id }, { orgId: null }] },
    });
    const author = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const last = await prisma.workItem.findFirst({
      where: { projectId: project.id },
      orderBy: { ticketNumber: "desc" },
      select: { ticketNumber: true },
    });
    const item = await prisma.workItem.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        ticketNumber: (last?.ticketNumber ?? 0) + 1,
        title: `labels fixture ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description: "",
        columnKey: "todo",
        workItemTypeId: type.id,
        createdById: author.id,
      },
    });
    created.workItemIds.push(item.id);
    return { org, item };
  }

  function track(labels: { id: string }[]) {
    created.labelIds.push(...labels.map((l) => l.id));
  }

  it("creates a label once and reuses it for any case-variant", async () => {
    const { org } = await makeItem();
    const suffix = Math.random().toString(36).slice(2, 8);

    const first = await resolveLabels(prisma, org.id, [`Sec-${suffix}`]);
    const second = await resolveLabels(prisma, org.id, [`SEC-${suffix}`]);
    track(first);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // The whole point of the functional unique index: one row, not two.
    expect(second[0].id).toBe(first[0].id);
    // And the catalogue keeps its original spelling rather than the caller's.
    expect(second[0].name).toBe(`Sec-${suffix}`);
  });

  it("writes BOTH sides — the join rows and the tags mirror", async () => {
    const { org, item } = await makeItem();
    const suffix = Math.random().toString(36).slice(2, 8);

    track(await setWorkItemLabels(prisma, org.id, item.id, [`Alpha-${suffix}`, `Beta-${suffix}`]));

    const joins = await prisma.workItemLabel.findMany({
      where: { workItemId: item.id },
      include: { label: true },
    });
    const after = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });

    expect(joins.map((j) => j.label.name).sort()).toEqual([
      `Alpha-${suffix}`,
      `Beta-${suffix}`,
    ]);
    // The mirror is what RAID, the AI tools and ingest still read. If this
    // drifts from the join rows, a label filters but disappears from RAID.
    expect([...after.tags].sort()).toEqual([`Alpha-${suffix}`, `Beta-${suffix}`]);
  });

  it("replaces rather than appends, and clears both sides when set to nothing", async () => {
    const { org, item } = await makeItem();
    const suffix = Math.random().toString(36).slice(2, 8);

    track(await setWorkItemLabels(prisma, org.id, item.id, [`Keep-${suffix}`, `Drop-${suffix}`]));
    track(await setWorkItemLabels(prisma, org.id, item.id, [`Keep-${suffix}`]));

    let joins = await prisma.workItemLabel.findMany({
      where: { workItemId: item.id },
      include: { label: true },
    });
    let after = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(joins.map((j) => j.label.name)).toEqual([`Keep-${suffix}`]);
    expect(after.tags).toEqual([`Keep-${suffix}`]);

    // Clearing is the case an empty IN-list would silently get wrong.
    await setWorkItemLabels(prisma, org.id, item.id, []);
    joins = await prisma.workItemLabel.findMany({
      where: { workItemId: item.id },
      include: { label: true },
    });
    after = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(joins).toHaveLength(0);
    expect(after.tags).toEqual([]);
  });

  it("stores the catalogue's spelling in the mirror, not the caller's", async () => {
    const { org, item } = await makeItem();
    const suffix = Math.random().toString(36).slice(2, 8);

    track(await resolveLabels(prisma, org.id, [`Security-${suffix}`]));
    // Caller uses a different case; the mirror must not reintroduce a variant
    // the migration just collapsed.
    await setWorkItemLabels(prisma, org.id, item.id, [`security-${suffix}`]);

    const after = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.tags).toEqual([`Security-${suffix}`]);
  });
});
