// @vitest-environment node
//
// API route-handler integration test for the ABAC-wired CRM-contact route.
// Mirrors the work-item harness (../../../projects/[projectId]/work-items/
// [itemId]/route.test.ts): mock the I/O boundaries, leave the authorization
// engine (requireAccess / evaluateAccess) UNMOCKED so the real ABAC decision
// runs against a crafted AuthContext.
//
// Focus of this file: the `owns_resource` deny-narrowing behaviour on PUT
// (CRM_UPDATE) and DELETE (CRM_DELETE). The route binds the resource owner via
// `requireAccess(ctx, "CRM_*", { ownerId: existing.ownerId })`, so an
// owns_resource deny must fire iff the loaded contact's ownerId === ctx.userId.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";
import { OrgRole } from "@prisma/client";

// --- I/O boundary mocks ------------------------------------------------------
// `vi.mock` factories are hoisted ABOVE the file's top-level consts, so the mock
// objects must be created in a `vi.hoisted` block (also hoisted) to be in scope.
const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    crmContact: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { PUT, DELETE } from "./route";

// --- ctx + fixture helpers ---------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const CONTACT_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_USER_ID = "99999999-9999-9999-9999-999999999999";

/** Build a permission bitfield from real Permission bits (no magic numbers). */
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

/** An UNCONDITIONAL deny on `action` — fires for everyone, no DB lookup needed
 *  (empty `conditions` = always fires). */
function unconditionalDeny(action: PermissionKey): AbacRule {
  return { effect: "deny", actions: [action], conditions: [] };
}

/** A deny that only fires when the actor OWNS the resource. owns_resource is
 *  computed purely from the resource attributes the route passes in. */
function ownsResourceDeny(action: PermissionKey): AbacRule {
  return { effect: "deny", actions: [action], conditions: [{ rel: "owns_resource" }] };
}

function putRequest(
  body: Record<string, unknown> = { name: "Updated", stage: "QUALIFIED" },
): NextRequest {
  return new NextRequest(
    "http://localhost/api/v1/orgs/o/crm/contacts/c",
    {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  );
}

function deleteRequest(): NextRequest {
  return new NextRequest("http://localhost/api/v1/orgs/o/crm/contacts/c", {
    method: "DELETE",
  });
}

const params = Promise.resolve({ orgId: ORG_ID, contactId: CONTACT_ID });

/** Stub `crmContact.findFirst` to return a contact owned by `ownerId`. */
function contactOwnedBy(ownerId: string | null) {
  prisma.crmContact.findFirst.mockResolvedValue({
    id: CONTACT_ID,
    orgId: ORG_ID,
    name: "Acme Corp",
    stage: "LEAD",
    value: null,
    dealValue: null,
    contactInfo: null,
    ownerId,
    notes: null,
    customFields: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // org resolves (so the route reaches the auth/authz stage)
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  // default: contact owned by SOMEONE ELSE (owns_resource → false). Individual
  // tests that exercise the narrowing re-stub the owner.
  contactOwnedBy(OTHER_USER_ID);
  prisma.crmContact.update.mockResolvedValue({
    id: CONTACT_ID,
    name: "Updated",
    stage: "QUALIFIED",
  });
  prisma.crmContact.delete.mockResolvedValue({ id: CONTACT_ID });
  logAudit.mockResolvedValue(undefined);
});

describe("PUT /crm/contacts/[contactId] — CRM_UPDATE authz (requireAccess)", () => {
  it("(a) ctx WITHOUT CRM_UPDATE → 403, and never touches the DB write", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("CRM_READ") }));

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.crmContact.update).not.toHaveBeenCalled();
  });

  it("(b) ctx WITH CRM_UPDATE and NO policy → success (200)", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: bits("CRM_READ", "CRM_UPDATE") }),
    );

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(200);
    expect(prisma.crmContact.update).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crm_contact.updated", entityId: CONTACT_ID }),
    );
  });

  it("(c) ctx WITH CRM_UPDATE but an UNCONDITIONAL deny on CRM_UPDATE → 403", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("CRM_READ", "CRM_UPDATE"),
        abacRules: [unconditionalDeny("CRM_UPDATE")],
      }),
    );

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.crmContact.update).not.toHaveBeenCalled();
  });

  // (d) owns_resource narrowing — proves the resource-owner attribute binds.
  it("(d) owns_resource deny FIRES when ctx.userId owns the contact → 403", async () => {
    contactOwnedBy(ACTOR_ID); // actor is the owner → owns_resource true
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("CRM_READ", "CRM_UPDATE"),
        abacRules: [ownsResourceDeny("CRM_UPDATE")],
      }),
    );

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.crmContact.update).not.toHaveBeenCalled();
  });

  it("(d) owns_resource deny does NOT fire when a DIFFERENT user owns the contact → 200", async () => {
    contactOwnedBy(OTHER_USER_ID); // actor is NOT the owner → owns_resource false
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("CRM_READ", "CRM_UPDATE"),
        abacRules: [ownsResourceDeny("CRM_UPDATE")],
      }),
    );

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(200);
    expect(prisma.crmContact.update).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /crm/contacts/[contactId] — CRM_DELETE authz (requireAccess)", () => {
  it("(a) ctx WITHOUT CRM_DELETE → 403, never deletes", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: bits("CRM_READ", "CRM_UPDATE") }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.crmContact.delete).not.toHaveBeenCalled();
  });

  it("(b) ctx WITH CRM_DELETE and no policy → 204 No Content", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: bits("CRM_READ", "CRM_DELETE") }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(204);
    expect(prisma.crmContact.delete).toHaveBeenCalledWith({ where: { id: CONTACT_ID } });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crm_contact.deleted" }),
    );
  });

  it("(c) ctx WITH CRM_DELETE but an unconditional CRM_DELETE deny → 403", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("CRM_READ", "CRM_DELETE"),
        abacRules: [unconditionalDeny("CRM_DELETE")],
      }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.crmContact.delete).not.toHaveBeenCalled();
  });

  // (d) owns_resource narrowing on DELETE — the spec's headline case.
  it("(d) owns_resource deny FIRES when ctx.userId owns the contact → 403", async () => {
    contactOwnedBy(ACTOR_ID);
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("CRM_READ", "CRM_DELETE"),
        abacRules: [ownsResourceDeny("CRM_DELETE")],
      }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.crmContact.delete).not.toHaveBeenCalled();
  });

  it("(d) owns_resource deny does NOT fire when a DIFFERENT user owns the contact → 204", async () => {
    contactOwnedBy(OTHER_USER_ID);
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("CRM_READ", "CRM_DELETE"),
        abacRules: [ownsResourceDeny("CRM_DELETE")],
      }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(204);
    expect(prisma.crmContact.delete).toHaveBeenCalledWith({ where: { id: CONTACT_ID } });
  });

  it("a null contact owner makes owns_resource unresolvable → deny fails CLOSED → 403", async () => {
    // CrmContact.ownerId is nullable. With a null owner the engine can't prove
    // the actor is NOT the owner, so an owns_resource deny still fires (the
    // fail-closed-deny invariant). Locks that the route passes ownerId as-is.
    contactOwnedBy(null);
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("CRM_READ", "CRM_DELETE"),
        abacRules: [ownsResourceDeny("CRM_DELETE")],
      }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.crmContact.delete).not.toHaveBeenCalled();
  });
});
