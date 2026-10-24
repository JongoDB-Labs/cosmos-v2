// @vitest-environment node
//
// Classification markings on feedback comments (design §3.2): staff on a gov
// tenant can mark a comment; one marked CUI or above stays internal unless the
// org ceiling covers it. Against the REAL e2e DB, in two throwaway orgs (one
// GOV, one COMMERCIAL) so no shared org's tenant class or ceiling changes
// under other suites. getAuthContext is mocked, and logAudit (asserted on, and
// it keeps append-only audit rows from pinning the throwaway orgs).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";

const { getAuthContext, getCurrentUser, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  getCurrentUser: vi.fn(),
  logAudit: vi.fn(async (_entry: unknown) => undefined),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext, getCurrentUser }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { prisma } from "@/lib/db/client";
import { GET, POST } from "./route";
import { PATCH } from "./[commentId]/route";
import { GET as REVISIONS } from "./[commentId]/revisions/route";
import {
  DELETE as DELETE_CLASSIFICATION,
  PATCH as PATCH_CLASSIFICATION,
  PUT as PUT_CLASSIFICATION,
} from "../../../classifications/[classificationId]/route";
import { POST as SET_CLASSIFICATION } from "../../../classifications/route";
import { PATCH as SET_TENANT_CLASS } from "@/app/api/internal/orgs/[orgId]/tenant-class/route";
import { GET as POLICY } from "../../comment-policy/route";
import { CommentChangeError, setVisibility, sweepAllMarkedComments } from "@/lib/feedback/comments.server";
import { appJobRunner } from "@/lib/jobs/runner";

const PREFIX = "[fb-marking-test]";
let govOrg: string;
let comOrg: string;
let alice: string;
let carol: string;
let govItem: string;
let comItem: string;
let orgId: string;
let itemId: string;

function as(userId: string, role: keyof typeof RolePermissions) {
  getAuthContext.mockResolvedValue({
    userId,
    orgId,
    orgRole: role,
    permissions: RolePermissions[role],
    basePermissions: RolePermissions[role],
    abacRules: [],
  });
}
const inOrg = (o: string, i: string) => {
  orgId = o;
  itemId = i;
};
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", { method, ...(body ? { body: JSON.stringify(body) } : {}) });
async function body(res: Response) {
  const j = await res.json();
  return j.data ?? j;
}
const post = (b: Record<string, unknown>) =>
  POST(req("POST", b), { params: Promise.resolve({ orgId, feedbackId: itemId }) } as never);
const policy = async () => body(await POLICY(req("GET"), { params: Promise.resolve({ orgId }) } as never));
const convert = (commentId: string) =>
  prisma.$transaction((tx) => setVisibility(tx, { orgId, feedbackItemId: itemId, commentId, visibility: "PUBLIC" }));
const patch = (commentId: string, b: Record<string, unknown>) =>
  PATCH(req("PATCH", b), { params: Promise.resolve({ orgId, feedbackId: itemId, commentId }) } as never);
const listIds = async () =>
  ((await body(await GET(req("GET"), { params: Promise.resolve({ orgId, feedbackId: itemId }) } as never))) as {
    id: string;
    replies: { id: string }[];
  }[]).flatMap((c) => [c.id, ...c.replies.map((r) => r.id)]);
const setCeiling = async (level: "CUI" | "CONFIDENTIAL" | null) => {
  await prisma.dataClassification.deleteMany({ where: { orgId: govOrg, projectId: null } });
  if (level) await prisma.dataClassification.create({ data: { orgId: govOrg, level, appliedById: alice } });
};

beforeAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { in: ["alice@test.local", "carol@test.local"] } },
    select: { id: true, email: true },
  });
  alice = users.find((u) => u.email === "alice@test.local")!.id;
  carol = users.find((u) => u.email === "carol@test.local")!.id;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const makeOrg = async (tenantClass: "GOV" | "COMMERCIAL") => {
    const id = (
      await prisma.organization.create({
        data: { name: `${PREFIX} ${stamp}`, slug: `fb-marking-${tenantClass.toLowerCase()}-${stamp}`, tenantClass },
      })
    ).id;
    await prisma.orgMember.createMany({
      data: [
        { orgId: id, userId: alice, role: "ADMIN" },
        { orgId: id, userId: carol, role: "MEMBER" },
      ],
    });
    return id;
  };
  govOrg = await makeOrg("GOV");
  comOrg = await makeOrg("COMMERCIAL");
  govItem = (
    await prisma.feedbackItem.create({ data: { orgId: govOrg, authorId: carol, type: "BUG", title: `${PREFIX} gov` } })
  ).id;
  comItem = (
    await prisma.feedbackItem.create({ data: { orgId: comOrg, authorId: carol, type: "BUG", title: `${PREFIX} commercial` } })
  ).id;
});

afterAll(async () => {
  const items = [govItem, comItem].filter(Boolean);
  await prisma.feedbackItem.updateMany({ where: { id: { in: items } }, data: { officialCommentId: null } });
  await prisma.comment.deleteMany({ where: { subjectType: "feedback", subjectId: { in: items } } });
  await prisma.feedbackItem.deleteMany({ where: { id: { in: items } } });
  const orgs = [govOrg, comOrg].filter(Boolean);
  await prisma.dataClassification.deleteMany({ where: { orgId: { in: orgs } } });
  await prisma.orgMember.deleteMany({ where: { orgId: { in: orgs } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } }).catch(() => undefined);
});

describe("comment markings (e2e DB)", () => {
  it("offers no marking outside a gov tenant, and refuses one", async () => {
    inOrg(comOrg, comItem);
    as(alice, "ADMIN");
    expect(await policy()).toEqual({ marking: null });
    expect((await post({ content: "x", classification: "CUI" })).status).toBe(400);
  });

  it("offers the picker to gov staff only, with the org ceiling", async () => {
    inOrg(govOrg, govItem);
    await setCeiling(null);
    as(alice, "ADMIN");
    expect(await policy()).toEqual({ marking: { orgCeiling: "UNCLASSIFIED" } });
    as(carol, "MEMBER");
    expect(await policy()).toEqual({ marking: null });
    expect((await post({ content: "x", classification: "UNCLASSIFIED" })).status).toBe(403);
  });

  let cui: string;
  it("keeps a CUI comment internal when the org isn't cleared for CUI", async () => {
    inOrg(govOrg, govItem);
    await setCeiling(null);
    as(alice, "ADMIN");
    const marked = await body(await post({ content: "Affected unit: redacted", classification: "CUI" }));
    expect(marked).toMatchObject({ classification: "CUI", visibility: "INTERNAL" });
    cui = marked.id;
    const plain = await body(await post({ content: "Repro steps attached", classification: "UNCLASSIFIED" }));
    expect(plain).toMatchObject({ classification: "UNCLASSIFIED", visibility: "PUBLIC" });
    expect((await post({ content: "x", classification: "CUI", kind: "OFFICIAL" })).status).toBe(400);
    await expect(convert(cui)).rejects.toBeInstanceOf(CommentChangeError);

    as(carol, "MEMBER");
    const seen = (await body(await GET(req("GET"), { params: Promise.resolve({ orgId, feedbackId: itemId }) } as never))) as {
      id: string;
      classification: string | null;
    }[];
    expect(seen.map((c) => c.id)).toEqual([plain.id]);
    expect(seen[0].classification).toBe("UNCLASSIFIED");
  });

  it("lets a CUI comment be public once the org ceiling is CUI", async () => {
    inOrg(govOrg, govItem);
    await setCeiling("CUI");
    as(alice, "ADMIN");
    expect(await body(await post({ content: "CUI, cleared org", classification: "CUI" }))).toMatchObject({
      visibility: "PUBLIC",
    });
    await convert(cui);
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: cui } })).visibility).toBe("PUBLIC");
  });

  it("never stores a marking above CUI that the org's ceiling doesn't cover, and audits what it stores", async () => {
    inOrg(govOrg, govItem);
    as(alice, "ADMIN");
    await setCeiling(null);
    expect((await post({ content: "x", classification: "CONFIDENTIAL" })).status).toBe(400);
    await setCeiling("CUI");
    expect((await post({ content: "x", classification: "CONFIDENTIAL" })).status).toBe(400);

    await setCeiling("CONFIDENTIAL");
    logAudit.mockClear();
    const c = await body(await post({ content: "cleared all the way", classification: "CONFIDENTIAL" }));
    expect(c).toMatchObject({ classification: "CONFIDENTIAL", visibility: "PUBLIC" });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "feedback.comment.marked",
        entityId: c.id,
        metadata: expect.objectContaining({ level: "CONFIDENTIAL", ceiling: "CONFIDENTIAL", visibility: "PUBLIC" }),
      }),
    );
  });

  it("hides a marked comment from members as soon as the ceiling stops covering it", async () => {
    inOrg(govOrg, govItem);
    await setCeiling("CUI");
    as(alice, "ADMIN");
    const official = await body(await post({ content: "Fix ships Friday (CUI)", classification: "CUI", kind: "OFFICIAL" }));
    expect(official).toMatchObject({ visibility: "PUBLIC", kind: "OFFICIAL" });
    as(carol, "MEMBER");
    expect(await listIds()).toContain(official.id);

    // The admin lowers the ceiling: no sweep, the next read hides it.
    await setCeiling(null);
    expect(await listIds()).not.toContain(official.id);
    expect((await REVISIONS(req("GET"), { params: Promise.resolve({ orgId, feedbackId: itemId, commentId: official.id }) } as never)).status).toBe(404);
    expect((await post({ content: "reply", parentId: official.id })).status).toBe(400);
    as(alice, "ADMIN");
    expect(await listIds()).toContain(official.id); // the team still sees it
    // And it can't be pinned again while it is over the ceiling.
    expect((await patch(official.id, { official: false })).status).toBe(200);
    expect((await patch(official.id, { official: true })).status).toBe(409);

    // Same when the tenant stops being a gov tenant.
    await setCeiling("CUI");
    as(carol, "MEMBER");
    expect(await listIds()).toContain(official.id);
    await prisma.organization.update({ where: { id: govOrg }, data: { tenantClass: "COMMERCIAL" } });
    try {
      expect(await listIds()).not.toContain(official.id);
    } finally {
      await prisma.organization.update({ where: { id: govOrg }, data: { tenantClass: "GOV" } });
    }
  });

  it("lets staff change a marking; raising a public one takes it and its replies internal", async () => {
    inOrg(govOrg, govItem);
    await setCeiling(null);
    as(alice, "ADMIN");
    const c = await body(await post({ content: `Logs from the site <@${carol}>`, kind: "OFFICIAL" }));
    as(carol, "MEMBER");
    const reply = await body(await post({ content: "That's our unit", parentId: c.id }));
    expect((await patch(c.id, { classification: "CUI" })).status).toBe(403);
    const anchor = { orgId: govOrg, userId: carol, url: { endsWith: `#c-${c.id}` } };
    expect(await prisma.notification.count({ where: anchor })).toBe(1);

    as(alice, "ADMIN");
    expect((await patch(c.id, { classification: "CONFIDENTIAL" })).status).toBe(409); // above what the org may hold
    logAudit.mockClear();
    expect((await patch(c.id, { classification: "CUI" })).status).toBe(200);
    const rows = await prisma.comment.findMany({ where: { id: { in: [c.id, reply.id] } }, select: { id: true, visibility: true, kind: true, classification: true } });
    expect(rows.find((r) => r.id === c.id)).toMatchObject({ visibility: "INTERNAL", kind: "COMMENT", classification: "CUI" });
    expect(rows.find((r) => r.id === reply.id)?.visibility).toBe("INTERNAL");
    expect((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: govItem } })).officialCommentId).toBeNull();
    expect(await prisma.notification.count({ where: anchor })).toBe(0);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "feedback.comment.marking_changed",
        metadata: expect.objectContaining({ from: null, to: "CUI", ceiling: "UNCLASSIFIED", tookInternal: true }),
      }),
    );
    as(carol, "MEMBER");
    const seen = await listIds();
    expect(seen).not.toContain(c.id);
    expect(seen).not.toContain(reply.id);

    // Lowering it makes nothing public by itself.
    as(alice, "ADMIN");
    expect((await patch(c.id, { classification: null })).status).toBe(200);
    expect(await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      classification: null,
      visibility: "INTERNAL",
    });
  });

  it("refuses to set a marking outside a gov tenant", async () => {
    inOrg(comOrg, comItem);
    as(alice, "ADMIN");
    const c = await body(await post({ content: "plain" }));
    expect((await patch(c.id, { classification: "UNCLASSIFIED" })).status).toBe(409);
  });

  describe("sweeping when the ceiling stops covering a marking", () => {
    async function markedWithReply() {
      as(alice, "ADMIN");
      const c = await body(await post({ content: `Site list attached <@${carol}>`, classification: "CUI" }));
      expect(c.visibility).toBe("PUBLIC");
      as(carol, "MEMBER");
      const reply = await body(await post({ content: "Ours is on it", parentId: c.id }));
      const note = { orgId: govOrg, userId: carol, url: { endsWith: `#c-${c.id}` } };
      expect(await prisma.notification.count({ where: note })).toBe(1);
      return { c, reply, note };
    }
    // The org holds other tests' marked comments too, so the sweep's counts
    // are checked as "at least this one and its reply".
    async function expectWithdrawn(c: { id: string }, reply: { id: string }, note: object, reason: string) {
      const rows = await prisma.comment.findMany({ where: { id: { in: [c.id, reply.id] } }, select: { visibility: true } });
      expect(rows.map((r) => r.visibility)).toEqual(["INTERNAL", "INTERNAL"]);
      expect(await prisma.notification.count({ where: note })).toBe(0);
      const sweep = logAudit.mock.calls
        .map(([e]) => e as { action: string; metadata: { reason: string; ceiling: string; comments: number; replies: number } })
        .find((e) => e.action === "feedback.comments.marking_sweep");
      expect(sweep?.metadata).toMatchObject({ reason, ceiling: "UNCLASSIFIED" });
      expect(sweep!.metadata.comments).toBeGreaterThanOrEqual(1);
      expect(sweep!.metadata.replies).toBeGreaterThanOrEqual(1);
    }

    it("withdraws them when an admin lowers the org ceiling", async () => {
      inOrg(govOrg, govItem);
      await setCeiling("CUI");
      const { c, reply, note } = await markedWithReply();
      const row = await prisma.dataClassification.findFirstOrThrow({ where: { orgId: govOrg, projectId: null } });

      as(alice, "ADMIN");
      logAudit.mockClear();
      const res = await DELETE_CLASSIFICATION(req("DELETE"), {
        params: Promise.resolve({ orgId: govOrg, classificationId: row.id }),
      } as never);
      expect(res.status).toBeLessThan(300);
      await expectWithdrawn(c, reply, note, "ceiling_changed");
    });

    it("withdraws them when the ceiling is lowered in place (POST, PUT or PATCH)", async () => {
      inOrg(govOrg, govItem);
      const lowerings: [string, (rowId: string) => Promise<Response>][] = [
        ["POST", () => SET_CLASSIFICATION(req("POST", { level: "UNCLASSIFIED" }), { params: Promise.resolve({ orgId: govOrg }) } as never)],
        ["PUT", (id) => PUT_CLASSIFICATION(req("PUT", { level: "UNCLASSIFIED" }), { params: Promise.resolve({ orgId: govOrg, classificationId: id }) } as never)],
        ["PATCH", (id) => PATCH_CLASSIFICATION(req("PATCH", { level: "UNCLASSIFIED" }), { params: Promise.resolve({ orgId: govOrg, classificationId: id }) } as never)],
      ];
      for (const [verb, lower] of lowerings) {
        await setCeiling("CUI");
        const { c, reply, note } = await markedWithReply();
        const row = await prisma.dataClassification.findFirstOrThrow({ where: { orgId: govOrg, projectId: null } });
        as(alice, "ADMIN");
        logAudit.mockClear();
        const res = await lower(row.id);
        expect(res.status, verb).toBeLessThan(300);
        await expectWithdrawn(c, reply, note, "ceiling_changed");
      }
    });

    it("withdraws them on the scheduled sweep when the in-request sweep never ran", async () => {
      inOrg(govOrg, govItem);
      await setCeiling("CUI");
      const { c, reply, note } = await markedWithReply();
      // Lowered behind the routes' back: no in-request sweep happens.
      await prisma.dataClassification.deleteMany({ where: { orgId: govOrg, projectId: null } });
      expect((await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).visibility).toBe("PUBLIC");

      logAudit.mockClear();
      const r = await sweepAllMarkedComments();
      expect(r.comments).toBeGreaterThanOrEqual(1);
      await expectWithdrawn(c, reply, note, "scheduled");
      const entry = logAudit.mock.calls.map(([e]) => e as { action: string; orgId: string; userId?: string })
        .find((e) => e.action === "feedback.comments.marking_sweep" && e.orgId === govOrg);
      expect(entry?.userId).toBeUndefined(); // nobody did it
    });

    it("stops before the next org once the job is cancelled", async () => {
      inOrg(govOrg, govItem);
      await setCeiling("CUI");
      const { c } = await markedWithReply();
      await prisma.dataClassification.deleteMany({ where: { orgId: govOrg, projectId: null } });
      const cancelled = new AbortController();
      cancelled.abort();
      const r = await sweepAllMarkedComments({ signal: cancelled.signal });
      expect(r).toMatchObject({ comments: 0, replies: 0 });
      expect((await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).visibility).toBe("PUBLIC");
      // The next tick picks it up.
      await sweepAllMarkedComments();
      expect((await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).visibility).toBe("INTERNAL");
    });

    it("runs the scheduled sweep as a registered job", async () => {
      await import("@/lib/jobs/jobs");
      expect(appJobRunner().status().map((j) => j.name)).toContain("feedback-marking-sweep");
    });

    it("withdraws them when the tenant stops being a gov tenant", async () => {
      inOrg(govOrg, govItem);
      await setCeiling("CUI");
      const { c, reply, note } = await markedWithReply();

      const admins = process.env.INTERNAL_ADMINS;
      process.env.INTERNAL_ADMINS = "alice@test.local";
      getCurrentUser.mockResolvedValue({ id: alice, email: "alice@test.local" });
      logAudit.mockClear();
      try {
        const res = await SET_TENANT_CLASS(req("PATCH", { tenantClass: "COMMERCIAL" }), {
          params: Promise.resolve({ orgId: govOrg }),
        } as never);
        expect(res.status).toBe(200);
        await expectWithdrawn(c, reply, note, "tenant_class_changed");
      } finally {
        process.env.INTERNAL_ADMINS = admins;
        await prisma.organization.update({ where: { id: govOrg }, data: { tenantClass: "GOV" } });
      }
    });
  });
});
