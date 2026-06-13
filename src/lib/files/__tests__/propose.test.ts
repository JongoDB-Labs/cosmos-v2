import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    put: vi.fn(async () => ({ url: "x", storageKey: "k" })),
    delete: vi.fn(async () => {}),
    stream: vi.fn(),
  }),
}));
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn(async () => {}) }));
// Mock the egress chokepoint so the test never calls a real model.
vi.mock("@/lib/ai/egress", () => ({
  runModelTurn: vi.fn(),
  toModelTools: (t: unknown) => t,
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/db/client";
import { runModelTurn } from "@/lib/ai/egress";
import { ingestDocument } from "../ingest";
import { proposeItems } from "../propose";

describe("proposeItems", () => {
  it("parses tool output, validates source anchors, drops untitled proposals", async () => {
    const org = await prisma.organization.findFirst({ where: { slug: "test-org" }, select: { id: true } });
    const project = await prisma.project.findFirst({ where: { orgId: org!.id, key: "TEST" }, select: { id: true } });
    const user = await prisma.user.findFirst({ select: { id: true } });
    const buf = readFileSync(join(process.cwd(), "src/lib/files/parsers/__tests__/fixtures/sample.docx"));
    const doc = await ingestDocument({
      orgId: org!.id, projectId: project!.id, uploadedById: user!.id,
      filename: "sample.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: buf,
    });
    const block = await prisma.documentBlock.findFirst({ where: { documentId: doc.id }, select: { anchor: true } });

    vi.mocked(runModelTurn).mockResolvedValue({
      text: "",
      stopReason: null,
      toolUses: [
        {
          id: "t1",
          name: "propose_items",
          input: {
            items: [
              { type: "ISSUE", title: "Real item", sourceAnchor: block!.anchor },
              { type: "MILESTONE", title: "Bad anchor item", sourceAnchor: "does-not-exist" },
              { type: "ISSUE", title: "" }, // dropped — no title
            ],
          },
        },
      ],
    } as never);

    const proposals = await proposeItems({
      orgId: org!.id, projectId: project!.id, userId: user!.id, docId: doc.id,
    });

    expect(proposals.map((p) => p.title)).toEqual(["Real item", "Bad anchor item"]);
    expect(proposals[0].sourceAnchor).toBe(block!.anchor); // valid anchor kept
    expect(proposals[0].type).toBe("ISSUE");
    expect(proposals[1].sourceAnchor).toBeNull(); // bogus anchor → null
    expect(proposals[1].type).toBe("MILESTONE");

    await prisma.document.delete({ where: { id: doc.id } });
  });
});
