// @vitest-environment node
//
// API route-handler integration test for the ABAC-wired notes route. Same
// harness as the CRM-contact + work-item tests: mock the I/O boundaries, leave
// the authorization engine (requireAccess / evaluateAccess) UNMOCKED so the real
// ABAC decision runs against a crafted AuthContext.
//
// Focus: the `owns_resource` deny-narrowing behaviour. The note's OWNER is
// `authorId`, which the route maps to `createdById` in its requireAccess call
// (`requireAccess(ctx, "NOTE_*", { createdById: existing.authorId })`). So an
// owns_resource deny must key off authorId.
//
// Wrinkle: the route ALSO has a manual author-or-admin guard AFTER requireAccess
// (PUT = author only; DELETE = author OR admin/owner). To isolate the
// requireAccess decision we craft ctx so that manual guard passes:
//   - "deny fires" cases  → authorId === ctx.userId (author guard passes AND
//     owns_resource is true), so a 403 can ONLY come from requireAccess.
//   - "deny does not fire" case → a DIFFERENT authorId with an ADMIN ctx (the
//     manual guard's admin branch passes), isolating requireAccess's allow.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";
import { OrgRole } from "@prisma/client";

// --- I/O boundary mocks ------------------------------------------------------
const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    note: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    orgMember: { findMany: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

// Best-effort side-effects the PUT path fires — stub so they don't reach real
// I/O. storeEmbedding resolves void so the re-embed branch is a no-op (no model
// load, no DB write).
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn() }));

import { PUT, DELETE } from "./route";

// --- ctx + fixture helpers ---------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const NOTE_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_USER_ID = "99999999-9999-9999-9999-999999999999";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(opts: {
  permissions: bigint;
  abacRules?: AbacRule[];
  orgRole?: OrgRole;
}): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: opts.orgRole ?? OrgRole.MEMBER,
    permissions: opts.permissions,
    basePermissions: opts.permissions,
    abacRules: opts.abacRules ?? [],
  };
}

function unconditionalDeny(action: PermissionKey): AbacRule {
  return { effect: "deny", actions: [action], conditions: [] };
}

/** A deny that only fires when the actor OWNS the resource (here: is author). */
function ownsResourceDeny(action: PermissionKey): AbacRule {
  return { effect: "deny", actions: [action], conditions: [{ rel: "owns_resource" }] };
}

function putRequest(
  body: Record<string, unknown> = { title: "Updated", content: "Body" },
): NextRequest {
  return new NextRequest("http://localhost/api/v1/orgs/o/notes/n", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function deleteRequest(): NextRequest {
  return new NextRequest("http://localhost/api/v1/orgs/o/notes/n", {
    method: "DELETE",
  });
}

const params = Promise.resolve({ orgId: ORG_ID, noteId: NOTE_ID });

/** Stub `note.findFirst` to return a note authored by `authorId`. */
function noteAuthoredBy(authorId: string) {
  prisma.note.findFirst.mockResolvedValue({
    id: NOTE_ID,
    orgId: ORG_ID,
    title: "Original",
    content: "Original body",
    authorId,
    visibility: "TEAM",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  // default: authored by the ACTOR (so the PUT/DELETE manual author guard passes
  // by default — tests override the author where they need a different owner).
  noteAuthoredBy(ACTOR_ID);
  prisma.note.update.mockResolvedValue({
    id: NOTE_ID,
    title: "Updated",
    content: "Body",
    authorId: ACTOR_ID,
  });
  prisma.note.delete.mockResolvedValue({ id: NOTE_ID });
  prisma.orgMember.findMany.mockResolvedValue([]);
  logAudit.mockResolvedValue(undefined);
});

describe("PUT /notes/[noteId] — NOTE_UPDATE authz (requireAccess)", () => {
  it("(a) ctx WITHOUT NOTE_UPDATE → 403, and never touches the DB write", async () => {
    // Author ctx (manual guard would pass) but lacks the NOTE_UPDATE bit, so the
    // 403 can only come from requireAccess.
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("NOTE_READ") }));

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.note.update).not.toHaveBeenCalled();
  });

  it("(b) ctx WITH NOTE_UPDATE and NO policy → success (200)", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: bits("NOTE_READ", "NOTE_UPDATE") }),
    );

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(200);
    expect(prisma.note.update).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "note.updated", entityId: NOTE_ID }),
    );
  });

  it("(c) ctx WITH NOTE_UPDATE but an UNCONDITIONAL deny on NOTE_UPDATE → 403", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("NOTE_READ", "NOTE_UPDATE"),
        abacRules: [unconditionalDeny("NOTE_UPDATE")],
      }),
    );

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.note.update).not.toHaveBeenCalled();
  });

  // (d) owns_resource narrowing keyed off authorId (mapped to createdById).
  it("(d) owns_resource deny FIRES when note.authorId === ctx.userId → 403", async () => {
    noteAuthoredBy(ACTOR_ID); // actor is the author → owns_resource true
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("NOTE_READ", "NOTE_UPDATE"),
        abacRules: [ownsResourceDeny("NOTE_UPDATE")],
      }),
    );

    const res = await PUT(putRequest(), { params });

    // 403 comes from requireAccess (the manual author guard would PASS here).
    expect(res.status).toBe(403);
    expect(prisma.note.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /notes/[noteId] — NOTE_DELETE authz (requireAccess)", () => {
  it("(a) ctx WITHOUT NOTE_DELETE → 403, never deletes", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: bits("NOTE_READ", "NOTE_UPDATE") }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.note.delete).not.toHaveBeenCalled();
  });

  it("(b) ctx WITH NOTE_DELETE and no policy → 204 No Content", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: bits("NOTE_READ", "NOTE_DELETE") }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(204);
    expect(prisma.note.delete).toHaveBeenCalledWith({ where: { id: NOTE_ID } });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "note.deleted" }),
    );
  });

  it("(c) ctx WITH NOTE_DELETE but an unconditional NOTE_DELETE deny → 403", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("NOTE_READ", "NOTE_DELETE"),
        abacRules: [unconditionalDeny("NOTE_DELETE")],
      }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.note.delete).not.toHaveBeenCalled();
  });

  // (d) owns_resource narrowing keyed off authorId.
  it("(d) owns_resource deny FIRES when note.authorId === ctx.userId → 403", async () => {
    noteAuthoredBy(ACTOR_ID); // actor is the author → owns_resource true
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("NOTE_READ", "NOTE_DELETE"),
        abacRules: [ownsResourceDeny("NOTE_DELETE")],
      }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.note.delete).not.toHaveBeenCalled();
  });

  it("(d) owns_resource deny does NOT fire when a DIFFERENT user authored the note → 204", async () => {
    // Author is someone else → owns_resource false → deny does not fire. The
    // ADMIN ctx lets the route's manual author-OR-admin guard pass, so the only
    // thing being exercised is requireAccess allowing the action.
    noteAuthoredBy(OTHER_USER_ID);
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("NOTE_READ", "NOTE_DELETE"),
        abacRules: [ownsResourceDeny("NOTE_DELETE")],
        orgRole: OrgRole.ADMIN,
      }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(204);
    expect(prisma.note.delete).toHaveBeenCalledWith({ where: { id: NOTE_ID } });
  });
});
