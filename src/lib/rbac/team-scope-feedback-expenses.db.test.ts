// @vitest-environment node
//
// Feedback and expenses filed under a team-scoped project are that team's,
// end to end: lists, counts, totals and exports leave them out for anyone
// outside the team; by id they answer the same 404 as a missing record; and
// naming the project in a create is a 403. Feedback and expenses under no
// project stay org-wide. Through the real routes, against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
// The attachment route streams from storage; serve every key, so only the
// visibility check can turn a request away.
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ stream: async () => new Response("file").body }),
}));

import { GET as listFeedback, POST as createFeedback } from "@/app/api/v1/orgs/[orgId]/feedback/route";
import { GET as getFeedback, PUT as updateFeedback } from "@/app/api/v1/orgs/[orgId]/feedback/[feedbackId]/route";
import { POST as vote } from "@/app/api/v1/orgs/[orgId]/feedback/[feedbackId]/vote/route";
import { POST as comment } from "@/app/api/v1/orgs/[orgId]/feedback/[feedbackId]/comments/route";
import { GET as getAttachment } from "@/app/api/v1/orgs/[orgId]/feedback/attachments/[attachmentId]/route";
import { GET as feedbackAnalytics } from "@/app/api/v1/orgs/[orgId]/analytics/feedback/route";
import { GET as listExpenses, POST as createExpense } from "@/app/api/v1/orgs/[orgId]/finance/expenses/route";
import { GET as getExpense, PUT as updateExpense } from "@/app/api/v1/orgs/[orgId]/finance/expenses/[expenseId]/route";
import { POST as approveExpense } from "@/app/api/v1/orgs/[orgId]/finance/expenses/[expenseId]/approve/route";
import { POST as bulkApprove } from "@/app/api/v1/orgs/[orgId]/finance/expenses/bulk-approve/route";
import { GET as financeSummary } from "@/app/api/v1/orgs/[orgId]/finance/summary/route";
import { GET as exportCsv } from "@/app/api/v1/orgs/[orgId]/export/csv/[entity]/route";
import { GET as exportJson } from "@/app/api/v1/orgs/[orgId]/export/json/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", restricted = "", outsider = "", insider = "";

beforeAll(async () => {
  outsider = (await prisma.user.create({ data: { email: `out-${stamp}@tsfe.test`, displayName: "Outsider" } })).id;
  insider = (await prisma.user.create({ data: { email: `in-${stamp}@tsfe.test`, displayName: "Insider" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `tsfe ${stamp}`, slug: `tsfe-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: outsider, role: "MEMBER", permissions: "0" } });
  const insiderMembership = await prisma.orgMember.create({ data: { orgId, userId: insider, role: "MEMBER", permissions: "0" } });
  restricted = (
    await prisma.project.create({ data: { orgId, name: "R", key: `FR${stamp.slice(0, 3).toUpperCase()}`, teamScopedAccess: true } })
  ).id;
  await prisma.projectMember.create({ data: { projectId: restricted, orgMemberId: insiderMembership.id, role: "MEMBER" } });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [outsider, insider] } } }).catch(() => undefined);
});

/** A member whose roles grant every bit: only visibility can refuse them. */
const member = (userId: string): AuthContext => ({ userId, orgId, orgRole: "MEMBER", abacRules: [], permissions: -1n, basePermissions: -1n });
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const at = <T extends Record<string, string>>(extra: T) => ({ params: Promise.resolve({ orgId, ...extra }) });
const as = (userId: string) => { h.ctx = member(userId); };

describe("feedback", () => {
  let hidden = "", open = "";
  beforeAll(async () => {
    hidden = (await prisma.feedbackItem.create({ data: { orgId, authorId: insider, title: `hidden ${stamp}`, type: "BUG", projectId: restricted } })).id;
    open = (await prisma.feedbackItem.create({ data: { orgId, authorId: insider, title: `open ${stamp}`, type: "BUG" } })).id;
  });

  const listed = async () => ((await (await listFeedback(req("GET"), at({}))).json()) as { id: string }[]).map((i) => i.id);

  it("the inbox leaves out the project's feedback for an outsider, and keeps feedback under no project", async () => {
    as(outsider);
    expect(await listed()).toEqual([open]);
    as(insider);
    expect((await listed()).sort()).toEqual([hidden, open].sort());
  });

  it("so do the inbox counts", async () => {
    const total = async () => ((await (await feedbackAnalytics(req("GET"), at({}))).json()) as { totals: { total: number; openBugs: number } }).totals;
    as(outsider);
    expect(await total()).toMatchObject({ total: 1, openBugs: 1 });
    as(insider);
    expect(await total()).toMatchObject({ total: 2, openBugs: 2 });
  });

  it("by id it's a 404 to an outsider: reading, editing, voting, commenting", async () => {
    as(outsider);
    expect((await getFeedback(req("GET"), at({ feedbackId: hidden }))).status).toBe(404);
    expect((await updateFeedback(req("PUT", { title: "x" }), at({ feedbackId: hidden }))).status).toBe(404);
    expect((await vote(req("POST"), at({ feedbackId: hidden }))).status).toBe(404);
    expect((await comment(req("POST", { content: "me too" }), at({ feedbackId: hidden }))).status).toBe(404);
    expect(await prisma.feedbackVote.count({ where: { feedbackItemId: hidden } })).toBe(0);
    expect(await prisma.comment.count({ where: { subjectId: hidden } })).toBe(0);
    expect((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: hidden } })).title).toBe(`hidden ${stamp}`);
  });

  it("the team reads, votes and comments as before, and anyone may still vote on feedback under no project", async () => {
    as(insider);
    expect((await getFeedback(req("GET"), at({ feedbackId: hidden }))).status).toBe(200);
    expect((await vote(req("POST"), at({ feedbackId: hidden }))).status).toBeLessThan(300);
    expect((await comment(req("POST", { content: "on it" }), at({ feedbackId: hidden }))).status).toBeLessThan(300);
    as(outsider);
    expect((await getFeedback(req("GET"), at({ feedbackId: open }))).status).toBe(200);
    expect((await vote(req("POST"), at({ feedbackId: open }))).status).toBeLessThan(300);
  });

  it("an attachment on the project's feedback is a 404 to an outsider; the team opens it", async () => {
    const attachmentId = (
      await prisma.feedbackAttachment.create({
        data: { orgId, feedbackItemId: hidden, kind: "image", url: "/x", storageKey: `k-${stamp}`, filename: "a.png", contentType: "image/png", size: 4, uploadedById: insider },
      })
    ).id;
    as(outsider);
    expect((await getAttachment(req("GET"), at({ attachmentId }))).status).toBe(404);
    as(insider);
    expect((await getAttachment(req("GET"), at({ attachmentId }))).status).toBe(200);
  });

  it("an outsider can't file feedback under the project (403); the team can", async () => {
    as(outsider);
    expect((await createFeedback(req("POST", { title: "t", projectId: restricted }), at({}))).status).toBe(403);
    as(insider);
    expect((await createFeedback(req("POST", { title: "t", projectId: restricted }), at({}))).status).toBeLessThan(300);
  });
});

describe("expenses", () => {
  const expenseIn = async (projectId: string | null, amount: number, status: "DRAFT" | "SUBMITTED" = "DRAFT") =>
    (await prisma.expense.create({ data: { orgId, projectId, amount, date: new Date("2026-10-20"), category: "travel", createdById: insider, status } })).id;
  let hidden = "", open = "";
  beforeAll(async () => {
    hidden = await expenseIn(restricted, 700);
    open = await expenseIn(null, 50);
  });

  it("the list and the summary leave out the project's expenses for an outsider", async () => {
    const ids = async () => ((await (await listExpenses(req("GET"), at({}))).json()) as { data: { id: string }[] }).data.map((e) => e.id);
    const spent = async () => ((await (await financeSummary(req("GET"), at({}))).json()) as { totalExpenses: number | null }).totalExpenses;
    as(outsider);
    expect(await ids()).toEqual([open]);
    expect(await spent()).toBe(50);
    as(insider);
    expect((await ids()).sort()).toEqual([hidden, open].sort());
    expect(await spent()).toBe(750);
  });

  it("by id it's a 404 to an outsider: reading, editing, approving", async () => {
    const submitted = await expenseIn(restricted, 10, "SUBMITTED");
    as(outsider);
    expect((await getExpense(req("GET"), at({ expenseId: hidden }))).status).toBe(404);
    expect((await updateExpense(req("PUT", { amount: 1 }), at({ expenseId: hidden }))).status).toBe(404);
    expect((await approveExpense(req("POST", { action: "approve" }), at({ expenseId: submitted }))).status).toBe(404);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: submitted } })).status).toBe("SUBMITTED");
    as(insider);
    expect((await getExpense(req("GET"), at({ expenseId: hidden }))).status).toBe(200);
  });

  it("bulk approval skips the project's expenses for an outsider, and approves the rest", async () => {
    const theirs = await expenseIn(restricted, 20, "SUBMITTED");
    const anyones = await expenseIn(null, 30, "SUBMITTED");
    as(outsider);
    expect((await bulkApprove(req("POST", { expenseIds: [theirs, anyones] }), at({}))).status).toBe(200);
    const status = async (id: string) => (await prisma.expense.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(theirs)).toBe("SUBMITTED");
    expect(await status(anyones)).toBe("APPROVED");
  });

  it("an outsider can't file an expense under the project (403); the team can", async () => {
    const body = { amount: 5, date: "2026-10-21", category: "meals", projectId: restricted };
    as(outsider);
    expect((await createExpense(req("POST", body), at({}))).status).toBe(403);
    as(insider);
    expect((await createExpense(req("POST", body), at({}))).status).toBe(201);
  });
});

describe("exports", () => {
  it("CSV and JSON leave out the project, and its expenses, for an outsider", async () => {
    const expenseId = (
      await prisma.expense.create({ data: { orgId, projectId: restricted, amount: 1, date: new Date("2026-10-20"), category: `exp-${stamp}`, createdById: insider } })
    ).id;
    const csv = async (entity: string) => (await exportCsv(req("GET"), at({ entity }))).text();
    const json = async () => (await (await exportJson(req("GET"), at({}))).json()) as { projects: { id: string }[]; expenses: { id: string }[] };
    as(outsider);
    expect(await csv("expenses")).not.toContain(expenseId);
    expect(await csv("projects")).not.toContain(restricted);
    const out = await json();
    expect(out.projects.map((p) => p.id)).not.toContain(restricted);
    expect(out.expenses.map((e) => e.id)).not.toContain(expenseId);
    expect(out.expenses.length).toBeGreaterThan(0); // the ones under no project
    as(insider);
    expect(await csv("expenses")).toContain(expenseId);
    const theirs = await json();
    expect(theirs.projects.map((p) => p.id)).toContain(restricted);
    expect(theirs.expenses.map((e) => e.id)).toContain(expenseId);
  });
});
