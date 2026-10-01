import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, resolveAuth, visibleProjectIdsForActor, ingestDocument, logAudit } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findMany: vi.fn() },
    document: { findMany: vi.fn() },
    // The route hydrates the uploader for the page: uploadedById has no FK, so a
    // name is resolved rather than joined.
    user: { findMany: vi.fn() },
  },
  resolveAuth: vi.fn(),
  visibleProjectIdsForActor: vi.fn(),
  ingestDocument: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/api-key", () => ({ resolveAuth }));
vi.mock("@/lib/rbac/project-access", () => ({ visibleProjectIdsForActor }));
vi.mock("@/lib/files/ingest", () => ({ ingestDocument }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { GET, POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ME = "22222222-2222-2222-2222-222222222222";
const OPEN_PROJECT = "33333333-3333-3333-3333-333333333333";
const RESTRICTED_PROJECT = "44444444-4444-4444-4444-444444444444";

const bits = (...keys: PermissionKey[]) => keys.reduce((a, k) => a | Permission[k], 0n);

function ctx(...keys: PermissionKey[]): AuthContext {
  const permissions = bits(...keys);
  return {
    userId: ME,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  } as AuthContext;
}

const req = (qs = "") => new NextRequest(`http://localhost/api/v1/orgs/o/documents${qs}`);
const params = Promise.resolve({ orgId: ORG_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "o" });
  resolveAuth.mockResolvedValue(ctx("ORG_READ", "PROJECT_READ"));
  prisma.project.findMany.mockResolvedValue([{ id: OPEN_PROJECT }, { id: RESTRICTED_PROJECT }]);
  // The actor is on the open project only.
  visibleProjectIdsForActor.mockResolvedValue(new Set([OPEN_PROJECT]));
  prisma.document.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  logAudit.mockResolvedValue(undefined);
});

/** The `where` the route actually sent to the database. */
const whereSent = () => prisma.document.findMany.mock.calls[0][0].where;

describe("GET /orgs/[orgId]/documents — the firm library", () => {
  it("asks only for documents on projects the actor can see, plus the firm's own", async () => {
    await GET(req(), { params });
    const where = whereSent();
    expect(where.orgId).toBe(ORG_ID);
    expect(where.OR).toEqual([{ projectId: null }, { projectId: { in: [OPEN_PROJECT] } }]);
  });

  it("never asks for a restricted project's documents", async () => {
    await GET(req(), { params });
    // The assertion that matters: dropping the narrowing would put this id in
    // the query, and every filename on a team-scoped job would be disclosed.
    expect(JSON.stringify(whereSent())).not.toContain(RESTRICTED_PROJECT);
  });

  it("narrows to the firm's own documents when asked", async () => {
    await GET(req("?scope=firm"), { params });
    expect(whereSent()).toEqual({ orgId: ORG_ID, projectId: null });
  });

  it("carries the project through so a row can say what it belongs to", async () => {
    await GET(req(), { params });
    const select = prisma.document.findMany.mock.calls[0][0].select;
    expect(select.projectId).toBe(true);
    expect(select.project).toEqual({ select: { key: true, name: true } });
  });

  it("refuses a reader who cannot read the org at all", async () => {
    resolveAuth.mockResolvedValue(ctx("PROJECT_READ"));
    const res = await GET(req(), { params });
    expect(res.status).toBe(403);
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });

  it("is unauthorized with no session", async () => {
    resolveAuth.mockResolvedValue(null);
    expect((await GET(req(), { params })).status).toBe(401);
  });
});

describe("POST /orgs/[orgId]/documents — adding to the firm library", () => {
  const upload = (name = "standard-details.pdf") =>
    new NextRequest(`http://localhost/api/v1/orgs/o/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: name,
        contentType: "application/pdf",
        dataBase64: Buffer.from("hello").toString("base64"),
      }),
    });

  it("stores it against no project", async () => {
    resolveAuth.mockResolvedValue(ctx("ORG_READ", "ORG_UPDATE"));
    ingestDocument.mockResolvedValue({ id: "d1" });
    const res = await POST(upload(), { params });
    expect(res.status).toBe(201);
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, projectId: null, uploadedById: ME }),
    );
  });

  it("is refused to someone who may read the org but not change it", async () => {
    resolveAuth.mockResolvedValue(ctx("ORG_READ", "PROJECT_READ", "PROJECT_UPDATE"));
    const res = await POST(upload(), { params });
    expect(res.status).toBe(403);
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("refuses an executable before storing anything", async () => {
    resolveAuth.mockResolvedValue(ctx("ORG_READ", "ORG_UPDATE"));
    const res = await POST(upload("payload.exe"), { params });
    expect(res.status).toBe(400);
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("stores a file nothing can parse — a library is not a parser", async () => {
    // The inverse of the test above, and the bug it replaces: upload used to be
    // gated on a parser existing, so five extensions were accepted and a
    // photograph, a CSV or a scanned certificate came back "Unsupported file
    // type". Those are exactly what a practice keeps.
    resolveAuth.mockResolvedValue(ctx("ORG_READ", "ORG_UPDATE"));
    for (const name of ["site-photo.png", "fees.csv", "insurance.pdf", "notes.txt", "details.dwg"]) {
      ingestDocument.mockClear();
      const res = await POST(upload(name), { params });
      expect(res.status, `${name} should be accepted`).toBeLessThan(400);
      expect(ingestDocument, `${name} should reach storage`).toHaveBeenCalled();
    }
  });
});

/**
 * Attribution. The column has no foreign key on purpose (a file outlives the account
 * that uploaded it), so these are about the route resolving a NAME and about the raw
 * id not leaking into a response any org reader can fetch.
 */
describe("GET /orgs/[orgId]/documents \u2014 who uploaded it", () => {
  it("returns the person, not the uuid", async () => {
    prisma.document.findMany.mockResolvedValue([
      { id: "d1", filename: "a.pdf", uploadedById: ME, projectId: null },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: ME, displayName: "Maggie", avatarUrl: null },
    ]);
    const body = await (await GET(req(), { params })).json();
    expect(body[0].uploadedBy).toEqual({ id: ME, displayName: "Maggie", avatarUrl: null });
    // The raw column is dropped: a list of user uuids is a roster, and this route is
    // readable by anyone who can read the org.
    expect(body[0]).not.toHaveProperty("uploadedById");
  });

  it("says Former member when the account is gone rather than dropping the row", async () => {
    prisma.document.findMany.mockResolvedValue([
      { id: "d1", filename: "a.pdf", uploadedById: ME, projectId: null },
    ]);
    prisma.user.findMany.mockResolvedValue([]); // the uploader has left
    const body = await (await GET(req(), { params })).json();
    expect(body).toHaveLength(1);
    expect(body[0].uploadedBy.displayName).toBe("Former member");
    expect(body[0].uploadedBy.id).toBe(ME);
  });

  it("resolves the page in ONE lookup, however many rows share an uploader", async () => {
    prisma.document.findMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({
        id: `d${i}`, filename: "a.pdf", uploadedById: ME, projectId: null,
      })),
    );
    await GET(req(), { params });
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    // ...and asks for the distinct set, not 25 copies of one id.
    expect(prisma.user.findMany.mock.calls[0][0].where.id.in).toEqual([ME]);
  });
});

describe("POST /orgs/[orgId]/documents \u2014 accounting", () => {
  it("records who uploaded what, so a library has a history and not just contents", async () => {
    ingestDocument.mockResolvedValue({
      id: "doc-1", filename: "insurance.pdf", size: 1234, contentType: "application/pdf",
    });
    resolveAuth.mockResolvedValue(ctx("ORG_READ", "ORG_UPDATE"));
    // JSON intake, as the other POST tests use: multipart cannot be constructed
    // against NextRequest in this environment, and the two paths converge on the
    // same ingest call anyway.
    const r = new NextRequest("http://localhost/api/v1/orgs/o/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "insurance.pdf",
        contentType: "application/pdf",
        dataBase64: Buffer.from("hello").toString("base64"),
      }),
    });
    await POST(r, { params });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        userId: ME,
        action: "document.upload",
        entity: "Document",
        entityId: "doc-1",
        metadata: expect.objectContaining({ filename: "insurance.pdf" }),
      }),
    );
  });
});
