// @vitest-environment node
//
// PATCH /orgs/{orgId}/clients/{clientId} — DB-free. Prisma is a small
// in-memory table that ENFORCES the (orgId, name) unique key, so the 409 comes
// from the same place it does in production rather than being scripted.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import { ForbiddenError } from "@/lib/rbac/check";

type Row = {
  id: string; orgId: string; name: string; legalName: string | null; email: string | null;
  phone: string | null; website: string | null; notes: string | null; active: boolean;
};

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ACME = "33333333-3333-4333-8333-333333333333";
const GLOBEX = "44444444-4444-4444-8444-444444444444";
const THEIRS = "55555555-5555-4555-8555-555555555555";

const { db, prisma, getAuthContext, logAudit, requirePermission } = vi.hoisted(() => ({
  db: { rows: [] as Row[] },
  prisma: {
    organization: { findUnique: vi.fn() },
    client: { findFirst: vi.fn(), update: vi.fn() },
  },
  getAuthContext: vi.fn(),
  logAudit: vi.fn(),
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/rbac/check", async (orig) => ({
  ...(await orig<typeof import("@/lib/rbac/check")>()),
  requirePermission,
}));

import { PATCH } from "./route";

const row = (over: Partial<Row>): Row => ({
  id: ACME, orgId: ORG, name: "Acme", legalName: null, email: null, phone: "555-0100",
  website: null, notes: "old note", active: true, ...over,
});

const patch = (clientId: string, body: unknown) =>
  PATCH(
    new NextRequest(`http://localhost/api/v1/orgs/${ORG}/clients/${clientId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId: ORG, clientId }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  db.rows = [row({}), row({ id: GLOBEX, name: "Globex", phone: null, notes: null }), row({ id: THEIRS, orgId: OTHER_ORG, name: "Theirs" })];
  prisma.organization.findUnique.mockResolvedValue({ slug: "org" });
  getAuthContext.mockResolvedValue({ orgId: ORG, userId: "u1" });
  requirePermission.mockImplementation(() => undefined);
  // Prisma semantics: a key absent from `where` does not filter. So a handler
  // that forgot the org would find another org's row here, as it would in prod.
  prisma.client.findFirst.mockImplementation(async ({ where }: { where: { id: string; orgId?: string } }) =>
    db.rows.find((r) => r.id === where.id && (where.orgId === undefined || r.orgId === where.orgId)) ?? null,
  );
  prisma.client.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const r = db.rows.find((x) => x.id === where.id)!;
    if (data.name !== undefined && db.rows.some((x) => x.id !== r.id && x.orgId === r.orgId && x.name === data.name)) {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    }
    Object.assign(r, data);
    return { ...r };
  });
});

describe("PATCH /clients/{clientId}", () => {
  it("changes only the fields given and returns the row", async () => {
    const res = await patch(ACME, { email: "ops@acme.test", notes: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    const out = body.data ?? body;
    expect(out).toMatchObject({ id: ACME, name: "Acme", email: "ops@acme.test", notes: null, phone: "555-0100" });
  });

  it("normalises the name the same way create does", async () => {
    await patch(ACME, { name: "  Acme   Holdings " });
    expect(db.rows.find((r) => r.id === ACME)!.name).toBe("Acme Holdings");
  });

  it("refuses a name that is only whitespace (400), and writes nothing", async () => {
    const res = await patch(ACME, { name: "   " });
    expect(res.status).toBe(400);
    expect(prisma.client.update).not.toHaveBeenCalled();
  });

  it("answers 409 when another client in the org already has the name", async () => {
    const res = await patch(ACME, { name: "Globex" });
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toMatch(/already has that name/);
    expect(db.rows.find((r) => r.id === ACME)!.name).toBe("Acme");
  });

  it("allows a name another ORG already uses — the key is per org", async () => {
    const res = await patch(ACME, { name: "Theirs" });
    expect(res.status).toBe(200);
  });

  it("a client of another org is a 404, the same as one that does not exist, and is not touched", async () => {
    const theirs = await patch(THEIRS, { notes: "mine now" });
    const missing = await patch("66666666-6666-4666-8666-666666666666", { notes: "x" });
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(db.rows.find((r) => r.id === THEIRS)!.notes).toBe("old note");
    expect(prisma.client.update).not.toHaveBeenCalled();
  });

  it("refuses a field the route does not know rather than ignoring it", async () => {
    const res = await patch(ACME, { orgId: OTHER_ORG });
    expect(res.status).toBe(400);
    expect(prisma.client.update).not.toHaveBeenCalled();
  });

  it("is gated on CRM_UPDATE, and a refusal writes nothing", async () => {
    requirePermission.mockImplementation(() => {
      throw new ForbiddenError("nope");
    });
    const res = await patch(ACME, { notes: "x" });
    expect(res.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), Permission.CRM_UPDATE);
    expect(prisma.client.update).not.toHaveBeenCalled();
  });

  it("audits WHICH fields changed, never their values", async () => {
    await patch(ACME, { email: "ops@acme.test", phone: "555-0199" });
    expect(logAudit).toHaveBeenCalledTimes(1);
    const entry = logAudit.mock.calls[0][0];
    expect(entry).toMatchObject({ action: "client.updated", entityId: ACME });
    expect(JSON.stringify(entry)).not.toContain("ops@acme.test");
    expect(JSON.stringify(entry)).not.toContain("555-0199");
    expect(entry.metadata.changes).toBe("email, phone");
  });
});
