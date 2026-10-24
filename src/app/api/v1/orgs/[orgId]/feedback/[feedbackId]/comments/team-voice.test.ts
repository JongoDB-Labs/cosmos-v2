// @vitest-environment node
//
// Feedback discussion, design Phase 2 "Team voice": internal notes, the
// official response, the staff visibility filter and converting between public
// and internal. Against the REAL e2e DB (test-org: alice ADMIN = staff, bob and
// carol MEMBER). Only getAuthContext is mocked.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";

const { getAuthContext, publishToOrg } = vi.hoisted(() => ({ getAuthContext: vi.fn(), publishToOrg: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg }));

import { prisma } from "@/lib/db/client";
import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[commentId]/route";
import { GET as REVISIONS } from "./[commentId]/revisions/route";

const PREFIX = "[fb-team-voice-test]";
let orgId: string;
let alice: string;
let bob: string;
let carol: string;
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
const p = (extra: Record<string, string> = {}) =>
  ({ params: Promise.resolve({ orgId, feedbackId: itemId, ...extra }) }) as never;
const req = (method: string, body?: unknown, qs = "") =>
  new NextRequest(`http://localhost/x${qs}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
async function body(res: Response) {
  const j = await res.json();
  return j.data ?? j;
}
const post = (b: Record<string, unknown>) => POST(req("POST", b), p());
const patch = (commentId: string, b: Record<string, unknown>) => PATCH(req("PATCH", b), p({ commentId }));
type Node = { id: string; kind: string; visibility: string; replies: Node[] };
const flat = (t: Node[]): Node[] => t.flatMap((c) => [c, ...c.replies]);
const ids = async (qs = "") => flat(await body(await GET(req("GET", undefined, qs), p()))).map((c) => c.id);
const getItem = () => prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } });

beforeAll(async () => {
  orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" } })).id;
  const users = await prisma.user.findMany({
    where: { email: { in: ["alice@test.local", "bob@test.local", "carol@test.local"] } },
    select: { id: true, email: true },
  });
  const id = (e: string) => users.find((u) => u.email === e)!.id;
  alice = id("alice@test.local");
  bob = id("bob@test.local");
  carol = id("carol@test.local");
  itemId = (
    await prisma.feedbackItem.create({ data: { orgId, authorId: bob, type: "FEATURE", title: `${PREFIX} export to PDF` } })
  ).id;
});

afterAll(async () => {
  const items = await prisma.feedbackItem.findMany({ where: { orgId, title: { startsWith: PREFIX } }, select: { id: true } });
  const all = items.map((i) => i.id);
  await prisma.feedbackItem.updateMany({ where: { id: { in: all } }, data: { officialCommentId: null } });
  await prisma.comment.deleteMany({ where: { orgId, subjectType: "feedback", subjectId: { in: all } } });
  await prisma.notification.deleteMany({ where: { orgId, refId: { in: all } } });
  await prisma.feedbackItem.deleteMany({ where: { id: { in: all } } });
});

describe("team voice (e2e DB)", () => {
  let note: string;
  let pub: string;

  it("keeps internal notes and official responses to the feedback team", async () => {
    as(carol, "MEMBER");
    expect((await post({ content: "psst", visibility: "INTERNAL" })).status).toBe(403);
    expect((await post({ content: "the answer", kind: "OFFICIAL" })).status).toBe(403);
  });

  it("hides an internal note from members, and from the count and last activity", async () => {
    as(carol, "MEMBER");
    const res = await post({ content: "Is this in scope?" });
    pub = (await body(res)).id;
    const before = await getItem();

    as(alice, "ADMIN");
    const n = await post({ content: `Needs eng review <@${carol}> <@${alice}>`, visibility: "INTERNAL" });
    expect(n.status).toBe(201);
    note = (await body(n)).id;

    const after = await getItem();
    expect(after.commentCount).toBe(before.commentCount);
    expect(after.lastActivityAt?.getTime()).toBe(before.lastActivityAt?.getTime());

    expect(await ids()).toEqual([pub, note]);
    expect(await ids("?visibility=internal")).toEqual([note]);
    expect(await ids("?visibility=public")).toEqual([pub]);
    as(carol, "MEMBER");
    expect(await ids()).toEqual([pub]);
    expect(await ids("?visibility=internal")).toEqual([pub]); // the filter is staff-only
    // An internal note never notifies someone outside the team, even mentioned.
    expect(
      await prisma.notification.count({ where: { orgId, userId: carol, refId: itemId, type: "feedback.comment.mentioned" } }),
    ).toBe(0);
  });

  it("keeps a reply to an internal note internal", async () => {
    as(alice, "ADMIN");
    const r = await body(await post({ content: "Agreed", parentId: note }));
    expect(r.visibility).toBe("INTERNAL");
  });

  it("pins one official response, and a new one replaces it", async () => {
    as(alice, "ADMIN");
    expect((await post({ content: "x", kind: "OFFICIAL", visibility: "INTERNAL" })).status).toBe(400);
    expect((await post({ content: "x", kind: "OFFICIAL", parentId: pub })).status).toBe(400);
    const first = (await body(await post({ content: "Planned for Q1.", kind: "OFFICIAL" }))).id;
    expect((await getItem()).officialCommentId).toBe(first);

    // Staff can promote someone else's public comment instead.
    expect((await patch(pub, { official: true })).status).toBe(200);
    expect((await getItem()).officialCommentId).toBe(pub);
    const kinds = await prisma.comment.findMany({ where: { id: { in: [first, pub] } }, select: { id: true, kind: true } });
    expect(Object.fromEntries(kinds.map((k) => [k.id, k.kind]))).toEqual({ [first]: "COMMENT", [pub]: "OFFICIAL" });

    expect((await patch(note, { official: true })).status).toBe(409); // internal can't be official
    expect((await patch(pub, { visibility: "INTERNAL" })).status).toBe(409); // unpin first
    expect((await patch(pub, { official: false })).status).toBe(200);
    expect((await getItem()).officialCommentId).toBeNull();

    // Deleting the official response unpins it.
    const again = (await body(await post({ content: "Shipping next week.", kind: "OFFICIAL" }))).id;
    expect((await DELETE(req("DELETE"), p({ commentId: again }))).status).toBe(200);
    expect((await getItem()).officialCommentId).toBeNull();
  });

  it("converts between public and internal, never pulling a member's words out of sight", async () => {
    as(alice, "ADMIN");
    const count = async () => (await getItem()).commentCount;
    const c0 = await count();
    expect((await patch(note, { visibility: "PUBLIC" })).status).toBe(200);
    expect(await count()).toBe(c0 + 1);

    // A public comment a member replied to stays public.
    as(carol, "MEMBER");
    await post({ content: "me too", parentId: note });
    as(alice, "ADMIN");
    expect((await patch(note, { visibility: "INTERNAL" })).status).toBe(409);

    // One only staff replied to goes internal with its replies, and the count follows.
    const own = (await body(await post({ content: "Heads up" }))).id;
    const staffReply = (await body(await post({ content: "noted", parentId: own }))).id;
    const c1 = await count();
    expect((await patch(own, { visibility: "INTERNAL" })).status).toBe(200);
    expect(await count()).toBe(c1 - 2);
    as(bob, "MEMBER");
    const seen = await ids();
    expect(seen).not.toContain(own);
    expect(seen).not.toContain(staffReply); // no orphaned staff reply left in public view

    // Members can't moderate.
    expect((await patch(pub, { visibility: "INTERNAL" })).status).toBe(403);
  });

  it("takes back the notifications quoting a comment once it goes internal", async () => {
    as(alice, "ADMIN");
    const c = (await body(await post({ content: `Heads up <@${bob}> <@${carol}>` }))).id;
    const other = (await body(await post({ content: `Unrelated <@${carol}>` }))).id;
    const anchor = (id: string) => ({ orgId, url: { endsWith: `#c-${id}` } });
    expect(await prisma.notification.count({ where: anchor(c) })).toBe(2);
    // A teammate's copy stays: they can still read the note.
    await prisma.notification.create({
      data: { orgId, userId: alice, type: "feedback.comment.mentioned", title: "t", refId: itemId, url: `/x#c-${c}` },
    });

    expect((await patch(c, { visibility: "INTERNAL" })).status).toBe(200);
    const left = await prisma.notification.findMany({ where: anchor(c), select: { userId: true } });
    expect(left.map((n) => n.userId)).toEqual([alice]);
    expect(await prisma.notification.count({ where: { ...anchor(other), userId: carol } })).toBe(1);
  });

  it("redacts an internal note's edit history when it goes public", async () => {
    as(alice, "ADMIN");
    const n = (await body(await post({ content: "draft: blocked on legal", visibility: "INTERNAL" }))).id;
    expect((await patch(n, { content: "We're looking into this." })).status).toBe(200);
    expect((await patch(n, { visibility: "PUBLIC" })).status).toBe(200);

    as(carol, "MEMBER");
    const revs = await body(await REVISIONS(req("GET"), p({ commentId: n })));
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ content: null, redacted: true });
  });

  it("lets only staff edit the official response while it is pinned", async () => {
    as(carol, "MEMBER");
    const c = (await body(await post({ content: "Workaround: export to CSV first." }))).id;
    as(alice, "ADMIN");
    expect((await patch(c, { official: true })).status).toBe(200);

    as(carol, "MEMBER");
    const mine = flat(await body(await GET(req("GET"), p()))).find((x) => x.id === c) as unknown as { canEdit: boolean };
    expect(mine.canEdit).toBe(false);
    expect((await patch(c, { content: "Ignore the team, this is wontfix." })).status).toBe(403);
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: c } })).content).toBe("Workaround: export to CSV first.");

    as(alice, "ADMIN");
    expect((await patch(c, { official: false })).status).toBe(200);
    as(carol, "MEMBER");
    expect((await patch(c, { content: "Workaround: export to CSV, then print." })).status).toBe(200);
  });

  it("never announces an internal note on the org-wide channel", async () => {
    as(alice, "ADMIN");
    const announced = () => publishToOrg.mock.calls.map((c) => (c[2] as { commentId: string }).commentId);
    publishToOrg.mockClear();
    const n = (await body(await post({ content: "staff only", visibility: "INTERNAL" }))).id;
    await patch(n, { content: "staff only, edited" });
    await DELETE(req("DELETE"), p({ commentId: n }));
    expect(announced()).not.toContain(n);

    const pubId = (await body(await post({ content: "for everyone" }))).id;
    expect(announced()).toContain(pubId);
  });
});
