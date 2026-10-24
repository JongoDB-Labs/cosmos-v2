// @vitest-environment node
//
// Classification markings on feedback comments (design §3.2): staff on a gov
// tenant can mark a comment; one marked CUI or above stays internal unless the
// org ceiling covers it. Against the REAL e2e DB, in two throwaway orgs (one
// GOV, one COMMERCIAL) so no shared org's tenant class or ceiling changes
// under other suites. Only getAuthContext is mocked.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { GET, POST } from "./route";
import { GET as POLICY } from "../../comment-policy/route";
import { CommentChangeError, setVisibility } from "@/lib/feedback/comments.server";

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
const setCeiling = async (level: "CUI" | null) => {
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

  it("lets a CUI comment be public once the org ceiling is CUI, but not one above it", async () => {
    inOrg(govOrg, govItem);
    await setCeiling("CUI");
    as(alice, "ADMIN");
    expect(await body(await post({ content: "CUI, cleared org", classification: "CUI" }))).toMatchObject({
      visibility: "PUBLIC",
    });
    expect(await body(await post({ content: "above the ceiling", classification: "CONFIDENTIAL" }))).toMatchObject({
      visibility: "INTERNAL",
    });
    await convert(cui);
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: cui } })).visibility).toBe("PUBLIC");
  });
});
