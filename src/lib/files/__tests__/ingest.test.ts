import { describe, it, expect, vi } from "vitest";

// Mock storage so the test never touches MinIO, keeping the adapters' key rule.
vi.mock("@/lib/storage", async () => {
  const { assertSafeStorageKey } = await import("@/lib/storage/keys");
  return {
    getStorage: () => ({
      put: vi.fn(async (key: string) => {
        assertSafeStorageKey(key);
        return { url: "x", storageKey: key };
      }),
      delete: vi.fn(async () => {}),
      stream: vi.fn(),
    }),
  };
});

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

  it("stores a file named '.' or '..' under a safe key, keeping its name for people", async () => {
    const org = await prisma.organization.findFirst({ where: { slug: "test-org" }, select: { id: true } });
    const user = await prisma.user.findFirst({ select: { id: true } });
    for (const filename of [".", ".."]) {
      const doc = await ingestDocument({
        orgId: org!.id,
        projectId: null,
        uploadedById: user!.id,
        filename,
        contentType: "text/plain",
        buffer: Buffer.from("notes"),
      });
      try {
        expect(doc.filename).toBe(filename);
        expect(doc.storageKey).toMatch(/\/file$/);
      } finally {
        await prisma.document.delete({ where: { id: doc.id } });
      }
    }
  });
});
