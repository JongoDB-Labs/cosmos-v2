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
import { convertBlockToWorkItem, convertTableToWorkItems } from "../convert";

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
