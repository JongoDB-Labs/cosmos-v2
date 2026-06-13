import { describe, it, expect, vi } from "vitest";

// Mock storage so the test never touches MinIO.
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    put: vi.fn(async () => ({ url: "x", storageKey: "k" })),
    delete: vi.fn(async () => {}),
    stream: vi.fn(),
  }),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/db/client";
import { ingestDocument } from "../ingest";

describe("ingestDocument", () => {
  it("stores + parses + persists blocks for a docx (status READY)", async () => {
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

    expect(doc.status).toBe("READY");
    expect(doc.format).toBe("docx");

    const blocks = await prisma.documentBlock.findMany({ where: { documentId: doc.id } });
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.anchor)).toBe(true);
    expect(blocks.some((b) => b.kind === "HEADING")).toBe(true);

    await prisma.document.delete({ where: { id: doc.id } }); // cascades blocks
  });
});
