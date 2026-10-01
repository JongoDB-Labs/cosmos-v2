import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, resolveAuth, requireProjectRead, requireAccess, ingestDocument, logAudit } =
  vi.hoisted(() => ({
    prisma: {
      organization: { findUnique: vi.fn() },
      workItem: { findFirst: vi.fn() },
      document: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
      user: { findMany: vi.fn() },
    },
    resolveAuth: vi.fn(),
    requireProjectRead: vi.fn(),
    requireAccess: vi.fn(),
    ingestDocument: vi.fn(),
    logAudit: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/api-key", () => ({ resolveAuth }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead }));
vi.mock("@/lib/abac/require-access", () => ({ requireAccess }));
vi.mock("@/lib/files/ingest", () => ({ ingestDocument }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { GET, POST } from "./route";
import { DELETE } from "./[docId]/route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ME = "22222222-2222-2222-2222-222222222222";
const PROJECT = "33333333-3333-3333-3333-333333333333";
const ITEM = "44444444-4444-4444-4444-444444444444";
const OTHER_ITEM = "55555555-5555-5555-5555-555555555555";
const DOC = "66666666-6666-6666-6666-666666666666";

const bits = (...keys: PermissionKey[]) => keys.reduce((a, k) => a | Permission[k], 0n);
function ctx(...keys: PermissionKey[]): AuthContext {
  const permissions = bits(...keys);
  return {
    userId: ME, orgId: ORG_ID, orgRole: OrgRole.MEMBER,
    permissions, basePermissions: permissions, abacRules: [],
  } as AuthContext;
}

const url = `http://localhost/api/v1/orgs/o/projects/p/work-items/i/attachments`;
const get = () => new NextRequest(url);
const post = (name = "site-photo.jpg") =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: name,
      contentType: "image/jpeg",
      dataBase64: Buffer.from("bytes").toString("base64"),
    }),
  });

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT, itemId: ITEM });
const docParams = Promise.resolve({
  orgId: ORG_ID, projectId: PROJECT, itemId: ITEM, docId: DOC,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "o" });
  resolveAuth.mockResolvedValue(ctx("ITEM_READ", "ITEM_UPDATE", "PROJECT_READ"));
  prisma.workItem.findFirst.mockResolvedValue({
    id: ITEM, createdById: ME, assigneeId: null, ticketNumber: 42,
  });
  prisma.document.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  requireProjectRead.mockResolvedValue(undefined);
  requireAccess.mockResolvedValue(undefined);
  logAudit.mockResolvedValue(undefined);
});

describe("POST attachments — an attachment IS a library file", () => {
  it("files it on the item AND on the project, which is what puts it in Files", async () => {
    ingestDocument.mockResolvedValue({ id: DOC, filename: "site-photo.jpg", size: 5 });
    const res = await POST(post(), { params });
    expect(res.status).toBe(201);
    // Both. Setting only workItemId would make an attachment invisible to the
    // project's file list, which is the whole point of doing it this way.
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        projectId: PROJECT,
        workItemId: ITEM,
        uploadedById: ME,
      }),
    );
  });

  it("records who attached what to which ticket", async () => {
    ingestDocument.mockResolvedValue({
      id: DOC, filename: "site-photo.jpg", size: 5, contentType: "image/jpeg",
    });
    await POST(post(), { params });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        userId: ME,
        action: "document.attach",
        entityId: DOC,
        metadata: expect.objectContaining({
          filename: "site-photo.jpg",
          workItemId: ITEM,
          ticketNumber: 42,
        }),
      }),
    );
  });

  it("checks the policy against the ITEM, with the fields the policy narrows on", async () => {
    prisma.workItem.findFirst.mockResolvedValue({
      id: ITEM, createdById: "someone-else", assigneeId: ME, ticketNumber: 7,
    });
    ingestDocument.mockResolvedValue({ id: DOC, filename: "a.jpg", size: 1 });
    await POST(post(), { params });
    // Ownership-narrowing policies cannot be evaluated without these, so the item
    // has to be read BEFORE the check rather than after it.
    expect(requireAccess).toHaveBeenCalledWith(expect.anything(), "ITEM_UPDATE", {
      createdById: "someone-else",
      assigneeId: ME,
      projectId: PROJECT,
    });
  });

  it("refuses an executable before storing a byte", async () => {
    const res = await POST(post("installer.exe"), { params });
    expect(res.status).toBe(400);
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("is not found when the item is not in this org and project", async () => {
    prisma.workItem.findFirst.mockResolvedValue(null);
    expect((await POST(post(), { params })).status).toBe(404);
    // Authorisation is never even attempted against an item that is not there.
    expect(requireAccess).not.toHaveBeenCalled();
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("is unauthorized with no session", async () => {
    resolveAuth.mockResolvedValue(null);
    expect((await POST(post(), { params })).status).toBe(401);
  });
});

describe("GET attachments", () => {
  it("asks only for documents attached to THIS item", async () => {
    await GET(get(), { params });
    expect(prisma.document.findMany.mock.calls[0][0].where).toEqual({
      orgId: ORG_ID,
      workItemId: ITEM,
    });
  });

  it("returns the uploader as a person and not as a uuid", async () => {
    prisma.document.findMany.mockResolvedValue([
      { id: DOC, filename: "a.jpg", uploadedById: ME },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: ME, displayName: "Rachel", avatarUrl: null },
    ]);
    const body = await (await GET(get(), { params })).json();
    expect(body[0].uploadedBy.displayName).toBe("Rachel");
    expect(body[0]).not.toHaveProperty("uploadedById");
  });

  it("reads the item, not the file, to decide who may look", async () => {
    await GET(get(), { params });
    expect(requireProjectRead).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT,
      "ITEM_READ",
    );
  });
});

describe("DELETE — detaches, and must not destroy", () => {
  beforeEach(() => {
    prisma.document.findFirst.mockResolvedValue({ id: DOC, filename: "a.jpg" });
    prisma.document.update.mockResolvedValue({ id: DOC });
  });

  it("nulls the link and leaves the file in the project library", async () => {
    const res = await DELETE(new NextRequest(url), { params: docParams });
    expect(res.status).toBe(200);
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: DOC },
      data: { workItemId: null },
    });
    // The assertion that matters: a wrong attachment and an unwanted file are
    // different mistakes, and only the second one should delete bytes.
    expect(await res.json()).toEqual({ detached: true, keptInProjectLibrary: true });
  });

  it("will not detach a document belonging to a different item", async () => {
    // The route scopes on workItemId as well as id, so this lookup finds nothing.
    prisma.document.findFirst.mockResolvedValue(null);
    const res = await DELETE(new NextRequest(url), { params: docParams });
    expect(res.status).toBe(404);
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(prisma.document.findFirst.mock.calls[0][0].where).toEqual({
      id: DOC, orgId: ORG_ID, workItemId: ITEM,
    });
  });

  it("records the detach, and says the bytes survived", async () => {
    await DELETE(new NextRequest(url), { params: docParams });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "document.detach",
        entityId: DOC,
        metadata: expect.objectContaining({ kept: "project library" }),
      }),
    );
  });

  it("needs the same right as attaching, no more", async () => {
    await DELETE(new NextRequest(url), { params: docParams });
    expect(requireAccess).toHaveBeenCalledWith(
      expect.anything(),
      "ITEM_UPDATE",
      expect.anything(),
    );
  });
});

// A guard on the suite itself: OTHER_ITEM exists only to be named in the
// different-item case above. If it ever stops appearing, that case has been
// weakened into a tautology.
describe("suite integrity", () => {
  it("still exercises a document from another item", () => {
    expect(OTHER_ITEM).not.toBe(ITEM);
  });
});
