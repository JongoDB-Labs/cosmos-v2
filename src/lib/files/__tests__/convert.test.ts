import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    put: vi.fn(async () => ({ url: "x", storageKey: "k" })),
    delete: vi.fn(async () => {}),
    stream: vi.fn(),
  }),
}));
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn(async () => {}) }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/db/client";
import { ingestDocument } from "../ingest";
import {
  convertBlockToWorkItem,
  convertBlockToMilestone,
  convertTableToWorkItems,
  convertBlockToItem,
  convertBlockToRoadmapNode,
} from "../convert";

describe("convertBlockToWorkItem", () => {
  it("creates a tagged work item from a block + a source link", async () => {
    const org = await prisma.organization.findFirst({ where: { slug: "test-org" }, select: { id: true } });
    const project = await prisma.project.findFirst({ where: { orgId: org!.id, key: "TEST" }, select: { id: true } });
    const user = await prisma.user.findFirst({ select: { id: true } });
    const buf = readFileSync(join(process.cwd(), "src/lib/files/parsers/__tests__/fixtures/sample.docx"));

    const doc = await ingestDocument({
      orgId: org!.id,
      projectId: project!.id,
      uploadedById: user!.id,
      filename: "sample.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: buf,
    });
    const block = await prisma.documentBlock.findFirst({
      where: { documentId: doc.id, kind: "PARAGRAPH" },
      select: { id: true },
    });

    const { item, link } = await convertBlockToWorkItem({
      orgId: org!.id,
      projectId: project!.id,
      blockId: block!.id,
      userId: user!.id,
    });

    expect(item.ticketNumber).toBeGreaterThan(0);
    expect(link.itemId).toBe(item.id);
    expect(link.itemType).toBe("WORK_ITEM");

    const wi = await prisma.workItem.findUnique({ where: { id: item.id }, select: { tags: true } });
    expect(wi!.tags).toContain("from-document");

    await prisma.workItem.delete({ where: { id: item.id } });
    await prisma.document.delete({ where: { id: doc.id } }); // cascades blocks + links
  });

  it("converts a block to a linked Milestone (default due date)", async () => {
    const org = await prisma.organization.findFirst({ where: { slug: "test-org" }, select: { id: true } });
    const project = await prisma.project.findFirst({ where: { orgId: org!.id, key: "TEST" }, select: { id: true } });
    const user = await prisma.user.findFirst({ select: { id: true } });
    const buf = readFileSync(join(process.cwd(), "src/lib/files/parsers/__tests__/fixtures/sample.docx"));
    const doc = await ingestDocument({
      orgId: org!.id, projectId: project!.id, uploadedById: user!.id,
      filename: "sample.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: buf,
    });
    const block = await prisma.documentBlock.findFirst({ where: { documentId: doc.id }, select: { id: true } });

    const { milestone, link } = await convertBlockToMilestone({
      orgId: org!.id, projectId: project!.id, blockId: block!.id, userId: user!.id, title: "Ship v3",
    });
    expect(milestone.title).toBe("Ship v3");
    expect(link.itemType).toBe("MILESTONE");
    const m = await prisma.milestone.findUnique({ where: { id: milestone.id }, select: { dueDate: true } });
    expect(m!.dueDate.getTime()).toBeGreaterThan(Date.now());

    await prisma.milestone.delete({ where: { id: milestone.id } });
    await prisma.document.delete({ where: { id: doc.id } });
  });

  it("maps a table block's rows to one linked Issue per data row", async () => {
    const org = await prisma.organization.findFirst({ where: { slug: "test-org" }, select: { id: true } });
    const project = await prisma.project.findFirst({ where: { orgId: org!.id, key: "TEST" }, select: { id: true } });
    const user = await prisma.user.findFirst({ select: { id: true } });
    const buf = readFileSync(join(process.cwd(), "src/lib/files/parsers/__tests__/fixtures/sample.xlsx"));
    const doc = await ingestDocument({
      orgId: org!.id, projectId: project!.id, uploadedById: user!.id,
      filename: "sample.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buf,
    });
    const tableBlock = await prisma.documentBlock.findFirst({
      where: { documentId: doc.id, kind: "TABLE" },
      select: { id: true },
    });

    // Sheet "Milestones": header + 2 data rows; title column 0 → 2 issues.
    const { count } = await convertTableToWorkItems({
      orgId: org!.id, projectId: project!.id, blockId: tableBlock!.id, userId: user!.id,
      titleColumn: 0, headerRow: true,
    });
    expect(count).toBe(2);

    const links = await prisma.documentItemLink.findMany({ where: { blockId: tableBlock!.id } });
    expect(links.length).toBe(2);
    const items = await prisma.workItem.findMany({ where: { id: { in: links.map((l) => l.itemId) } }, select: { title: true } });
    expect(items.map((i) => i.title).sort()).toEqual(["SSP baseline", "UAT"]);

    await prisma.workItem.deleteMany({ where: { id: { in: links.map((l) => l.itemId) } } });
    await prisma.document.delete({ where: { id: doc.id } });
  });
});

describe("convertBlockToItem — marginal types (OKR / Goal / Sprint / Roadmap node)", () => {
  it("converts a block into each item type with a matching source link", async () => {
    const org = await prisma.organization.findFirst({ where: { slug: "test-org" }, select: { id: true } });
    const project = await prisma.project.findFirst({ where: { orgId: org!.id, key: "TEST" }, select: { id: true } });
    const user = await prisma.user.findFirst({ select: { id: true } });
    const buf = readFileSync(join(process.cwd(), "src/lib/files/parsers/__tests__/fixtures/sample.docx"));
    const doc = await ingestDocument({
      orgId: org!.id, projectId: project!.id, uploadedById: user!.id,
      filename: "sample.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: buf,
    });
    const block = await prisma.documentBlock.findFirst({
      where: { documentId: doc.id, kind: "PARAGRAPH" },
      select: { id: true },
    });

    const cases = [
      { itemType: "OBJECTIVE", del: (id: string) => prisma.objective.delete({ where: { id } }) },
      { itemType: "GOAL", del: (id: string) => prisma.goal.delete({ where: { id } }) },
      { itemType: "CYCLE", del: (id: string) => prisma.cycle.delete({ where: { id } }) },
      { itemType: "ROADMAP_NODE", del: (id: string) => prisma.roadmapNode.delete({ where: { id } }) },
    ] as const;

    const created: { id: string; del: (id: string) => Promise<unknown> }[] = [];
    for (const c of cases) {
      const res = await convertBlockToItem({
        orgId: org!.id, projectId: project!.id, blockId: block!.id, userId: user!.id,
        itemType: c.itemType, title: `From doc — ${c.itemType}`,
      });
      expect(res.itemType).toBe(c.itemType);
      expect(res.id).toBeTruthy();
      expect(res.ticketNumber).toBeNull();
      const link = await prisma.documentItemLink.findFirst({
        where: { blockId: block!.id, itemType: c.itemType, itemId: res.id },
      });
      expect(link).not.toBeNull();
      created.push({ id: res.id, del: c.del });
    }

    for (const c of created) await c.del(c.id);
    await prisma.document.delete({ where: { id: doc.id } });
  });

  it("de-duplicates roadmap-node anchors when two are created from the same title", async () => {
    const org = await prisma.organization.findFirst({ where: { slug: "test-org" }, select: { id: true } });
    const project = await prisma.project.findFirst({ where: { orgId: org!.id, key: "TEST" }, select: { id: true } });
    const user = await prisma.user.findFirst({ select: { id: true } });
    const buf = readFileSync(join(process.cwd(), "src/lib/files/parsers/__tests__/fixtures/sample.docx"));
    const doc = await ingestDocument({
      orgId: org!.id, projectId: project!.id, uploadedById: user!.id,
      filename: "sample.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: buf,
    });
    const block = await prisma.documentBlock.findFirst({ where: { documentId: doc.id }, select: { id: true } });

    const a = await convertBlockToRoadmapNode({
      orgId: org!.id, projectId: project!.id, blockId: block!.id, userId: user!.id, title: "Phase One",
    });
    const b = await convertBlockToRoadmapNode({
      orgId: org!.id, projectId: project!.id, blockId: block!.id, userId: user!.id, title: "Phase One",
    });
    expect(a.node.anchor).not.toBe(b.node.anchor);

    await prisma.roadmapNode.deleteMany({ where: { id: { in: [a.node.id, b.node.id] } } });
    await prisma.document.delete({ where: { id: doc.id } });
  });
});
