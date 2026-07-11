// @vitest-environment node
//
// PUT/DELETE /feedback/[feedbackId] authorization (COSMOS-85 + COSMOS-49),
// against the REAL e2e DB (seeded `test-org` with users alice@test.local +
// bob@test.local). Only `getAuthContext` is mocked — session cookies aren't
// available in a route-handler test — so the caller's permissions are whatever
// we hand it; `@/lib/db/client` is left unmocked so the real row is read/written.
//
// Ownership model under test:
//  - A plain member who AUTHORED an FR/BR can edit its own title/description
//    (COSMOS-85 — the handler used to require ORG_UPDATE for EVERY update, so an
//    author got a 403 editing their own words) and delete its own item.
//  - An admin (ORG_UPDATE) can edit AND delete ANY member's FR/BR (COSMOS-49:
//    "admins can edit/delete any FR/BR").
//  - A non-author WITHOUT ORG_UPDATE can do neither.
//  - Status triage stays admin-only (ORG_UPDATE).
//
// Every row a test creates is deleted in a `finally`, so a failed assertion
// never leaves the shared e2e DB dirty for the next run.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { PUT, DELETE } from "./route";

const TITLE_PREFIX = "[COSMOS-85-put-test]";

let orgId: string;
let aliceId: string;
let bobId: string;

/** A minimal AuthContext for a non-owner caller with the given permission bits. */
function ctxFor(
  userId: string,
  permissions: bigint,
  orgRole: OrgRole = OrgRole.MEMBER,
): AuthContext {
  return { userId, orgId, orgRole, permissions, basePermissions: permissions, abacRules: [] };
}

function put(feedbackId: string, body: unknown) {
  const request = new NextRequest(
    `http://localhost/api/v1/orgs/${orgId}/feedback/${feedbackId}`,
    { method: "PUT", body: JSON.stringify(body) },
  );
  return PUT(request, { params: Promise.resolve({ orgId, feedbackId }) });
}

function del(feedbackId: string) {
  const request = new NextRequest(
    `http://localhost/api/v1/orgs/${orgId}/feedback/${feedbackId}`,
    { method: "DELETE" },
  );
  return DELETE(request, { params: Promise.resolve({ orgId, feedbackId }) });
}

/** Create a feedback item authored by `authorId`; returns its id. */
async function seedItem(authorId: string, title: string) {
  const row = await prisma.feedbackItem.create({
    data: { orgId, authorId, type: "FEATURE", title, description: "before" },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({
    where: { slug: "test-org" },
    select: { id: true },
  });
  orgId = org.id;

  const alice = await prisma.user.findFirstOrThrow({
    where: { email: "alice@test.local" },
    select: { id: true },
  });
  aliceId = alice.id;

  const bob = await prisma.user.findFirstOrThrow({
    where: { email: "bob@test.local" },
    select: { id: true },
  });
  bobId = bob.id;

  await prisma.feedbackItem.deleteMany({
    where: { orgId, title: { startsWith: TITLE_PREFIX } },
  });
});

describe("PUT /feedback/[feedbackId] — content edits are author-owned", () => {
  it("lets a plain member author edit its own title/description without ORG_UPDATE", async () => {
    const id = await seedItem(aliceId, `${TITLE_PREFIX} author edit`);
    try {
      getAuthContext.mockResolvedValue(ctxFor(aliceId, Permission.ORG_READ));

      const res = await put(id, { title: `${TITLE_PREFIX} edited`, description: "after" });
      expect(res.status).toBe(200);

      const row = await prisma.feedbackItem.findUniqueOrThrow({
        where: { id },
        select: { title: true, description: true },
      });
      expect(row.title).toBe(`${TITLE_PREFIX} edited`);
      expect(row.description).toBe("after");
    } finally {
      await prisma.feedbackItem.deleteMany({ where: { id } });
    }
  });

  it("rejects a non-author (even a member) editing someone else's content with 403", async () => {
    const id = await seedItem(aliceId, `${TITLE_PREFIX} not yours`);
    try {
      getAuthContext.mockResolvedValue(ctxFor(bobId, Permission.ORG_READ));

      const res = await put(id, { title: `${TITLE_PREFIX} hijacked` });
      expect(res.status).toBe(403);
      // The body carries a specific, user-facing reason (not a bare status) so
      // the portal can surface it verbatim rather than a generic fallback.
      const body = await res.json();
      expect(body.error).toMatch(/only the author/i);

      const row = await prisma.feedbackItem.findUniqueOrThrow({
        where: { id },
        select: { title: true },
      });
      expect(row.title).toBe(`${TITLE_PREFIX} not yours`); // unchanged
    } finally {
      await prisma.feedbackItem.deleteMany({ where: { id } });
    }
  });

  it("lets an admin (ORG_UPDATE) edit another member's content (COSMOS-49)", async () => {
    const id = await seedItem(aliceId, `${TITLE_PREFIX} admin rewrite`);
    try {
      getAuthContext.mockResolvedValue(
        ctxFor(bobId, Permission.ORG_READ | Permission.ORG_UPDATE, OrgRole.ADMIN),
      );

      const res = await put(id, {
        title: `${TITLE_PREFIX} admin edited`,
        description: "after",
      });
      expect(res.status).toBe(200);

      const row = await prisma.feedbackItem.findUniqueOrThrow({
        where: { id },
        select: { title: true, description: true },
      });
      expect(row.title).toBe(`${TITLE_PREFIX} admin edited`);
      expect(row.description).toBe("after");
    } finally {
      await prisma.feedbackItem.deleteMany({ where: { id } });
    }
  });
});

describe("PUT /feedback/[feedbackId] — status triage stays admin-only", () => {
  it("rejects a plain member author changing status with 403", async () => {
    const id = await seedItem(aliceId, `${TITLE_PREFIX} self triage`);
    try {
      getAuthContext.mockResolvedValue(ctxFor(aliceId, Permission.ORG_READ));

      const res = await put(id, { status: "DONE" });
      expect(res.status).toBe(403);

      const row = await prisma.feedbackItem.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      expect(row.status).toBe("OPEN"); // unchanged
    } finally {
      await prisma.feedbackItem.deleteMany({ where: { id } });
    }
  });

  it("lets an admin (ORG_UPDATE) triage another member's item's status", async () => {
    const id = await seedItem(aliceId, `${TITLE_PREFIX} admin triage`);
    try {
      getAuthContext.mockResolvedValue(
        ctxFor(bobId, Permission.ORG_READ | Permission.ORG_UPDATE, OrgRole.ADMIN),
      );

      const res = await put(id, { status: "PLANNED" });
      expect(res.status).toBe(200);

      const row = await prisma.feedbackItem.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      expect(row.status).toBe("PLANNED");
    } finally {
      await prisma.feedbackItem.deleteMany({ where: { id } });
    }
  });
});

describe("DELETE /feedback/[feedbackId] — author deletes own; admin deletes any (COSMOS-49)", () => {
  it("lets a plain member author delete its own item", async () => {
    const id = await seedItem(aliceId, `${TITLE_PREFIX} author delete`);
    try {
      getAuthContext.mockResolvedValue(ctxFor(aliceId, Permission.ORG_READ));

      const res = await del(id);
      expect(res.status).toBe(200);

      const row = await prisma.feedbackItem.findUnique({ where: { id } });
      expect(row).toBeNull(); // gone
    } finally {
      await prisma.feedbackItem.deleteMany({ where: { id } });
    }
  });

  it("rejects a non-author member deleting someone else's item with 403", async () => {
    const id = await seedItem(aliceId, `${TITLE_PREFIX} not yours delete`);
    try {
      getAuthContext.mockResolvedValue(ctxFor(bobId, Permission.ORG_READ));

      const res = await del(id);
      expect(res.status).toBe(403);

      const row = await prisma.feedbackItem.findUnique({ where: { id } });
      expect(row).not.toBeNull(); // still there
    } finally {
      await prisma.feedbackItem.deleteMany({ where: { id } });
    }
  });

  it("lets an admin (ORG_UPDATE) delete another member's item", async () => {
    const id = await seedItem(aliceId, `${TITLE_PREFIX} admin delete`);
    try {
      getAuthContext.mockResolvedValue(
        ctxFor(bobId, Permission.ORG_READ | Permission.ORG_UPDATE, OrgRole.ADMIN),
      );

      const res = await del(id);
      expect(res.status).toBe(200);

      const row = await prisma.feedbackItem.findUnique({ where: { id } });
      expect(row).toBeNull(); // gone
    } finally {
      await prisma.feedbackItem.deleteMany({ where: { id } });
    }
  });
});
