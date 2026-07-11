import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listDocuments } from "./documents";
import type { ToolContext } from "./_ctx";

const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("documents executor (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `doc-test ${stamp}`, slug: `doc-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const project = await prisma.project.create({
      data: { orgId: org.id, name: "P", key: `DC${stamp.slice(-4).toUpperCase()}` },
    });
    await prisma.document.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        title: "Spec",
        storageKey: `k-${stamp}`,
        filename: "spec.pdf",
        contentType: "application/pdf",
        size: 1234,
        uploadedById: owner.id,
      },
    });
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    const denyCtx: ToolContext = { orgId: org.id, userId: NON_MEMBER };
    return { org, project, ctx, denyCtx };
  }

  it("list_documents returns the project's documents with structural fields", async () => {
    const { ctx, project } = await makeOrg();
    const res = (await listDocuments({ projectId: project.id }, ctx)) as {
      count: number;
      documents: { contentType: string; size: number }[];
    };
    expect(res.count).toBe(1);
    expect(res.documents[0].contentType).toBe("application/pdf");
    expect(res.documents[0].size).toBe(1234);
  });

  it("denies a non-member (no PROJECT_READ)", async () => {
    const { denyCtx, project } = await makeOrg();
    expect(await listDocuments({ projectId: project.id }, denyCtx)).toEqual({ error: "Insufficient permissions" });
  });
});
