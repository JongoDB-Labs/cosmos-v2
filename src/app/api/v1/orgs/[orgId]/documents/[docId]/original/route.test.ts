import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, getAuthContext, getStorage, stream } = vi.hoisted(
  () => ({
    prisma: {
      organization: { findUnique: vi.fn() },
      document: { findFirst: vi.fn() },
      // Read by the REAL getVisibleProjectIds.
      project: { findMany: vi.fn() },
      orgMember: { findUnique: vi.fn() },
      projectMember: { findMany: vi.fn() },
    },
    getAuthContext: vi.fn(),
    getStorage: vi.fn(),
    stream: vi.fn(),
  }),
);

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/storage", () => ({ getStorage }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ME = "22222222-2222-2222-2222-222222222222";
const OPEN_PROJECT = "33333333-3333-3333-3333-333333333333";
const RESTRICTED_PROJECT = "44444444-4444-4444-4444-444444444444";
const DOC_ID = "55555555-5555-5555-5555-555555555555";

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

const doc = (projectId: string | null) => ({
  storageKey: "documents/org/x/y/standard-details.pdf",
  contentType: "application/pdf",
  filename: "standard-details.pdf",
  projectId,
});

const req = () => new NextRequest(`http://localhost/api/v1/orgs/o/documents/${DOC_ID}/original`);
const params = Promise.resolve({ orgId: ORG_ID, docId: DOC_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "o" });
  getAuthContext.mockResolvedValue(ctx("ORG_READ", "PROJECT_READ"));
  const projects = [
    { id: OPEN_PROJECT, teamScopedAccess: false },
    { id: RESTRICTED_PROJECT, teamScopedAccess: true },
  ];
  prisma.project.findMany.mockImplementation(async (a: { where: { id: { in: string[] } } }) =>
    projects.filter((p) => a.where.id.in.includes(p.id)),
  );
  prisma.orgMember.findUnique.mockResolvedValue({ id: "member-1" });
  // A member of neither project's team: only the open one is visible.
  prisma.projectMember.findMany.mockResolvedValue([]);
  getStorage.mockReturnValue({ stream });
  stream.mockResolvedValue(new ReadableStream());
});

describe("GET a library document's original bytes", () => {
  it("serves a firm-wide document without asking about any project", async () => {
    prisma.document.findFirst.mockResolvedValue(doc(null));
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it("serves a project document when the reader may see that project", async () => {
    prisma.document.findFirst.mockResolvedValue(doc(OPEN_PROJECT));
    expect((await GET(req(), { params })).status).toBe(200);
  });

  it("will not serve one from a project the reader cannot see", async () => {
    prisma.document.findFirst.mockResolvedValue(doc(RESTRICTED_PROJECT));
    const res = await GET(req(), { params });
    // 404, not 403: whether a restricted job holds this file is itself
    // something the reader should not be able to determine — and the bytes are
    // never fetched from storage.
    expect(res.status).toBe(404);
    expect(stream).not.toHaveBeenCalled();
  });

  it("will not serve one outside an API key's project scope", async () => {
    getAuthContext.mockResolvedValue({ ...ctx("ORG_READ", "PROJECT_READ"), projectScope: [RESTRICTED_PROJECT] });
    prisma.document.findFirst.mockResolvedValue(doc(OPEN_PROJECT));
    expect((await GET(req(), { params })).status).toBe(404);
    expect(stream).not.toHaveBeenCalled();
  });

  it("returns 404 for a document that is not in this org", async () => {
    prisma.document.findFirst.mockResolvedValue(null);
    expect((await GET(req(), { params })).status).toBe(404);
    expect(stream).not.toHaveBeenCalled();
  });

  it("refuses a reader who cannot read the org", async () => {
    getAuthContext.mockResolvedValue(ctx("PROJECT_READ"));
    const res = await GET(req(), { params });
    expect(res.status).toBe(403);
    expect(prisma.document.findFirst).not.toHaveBeenCalled();
  });

  it("is unauthorized with no session", async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await GET(req(), { params })).status).toBe(401);
  });
});
