// @vitest-environment node
//
// update_note and share_note against PUT /notes/{noteId}, for the SAME real
// actor, in a real database (e2e DB). The route asks
// `requireAccess(ctx, "NOTE_UPDATE", { createdById: note.authorId })` before
// it writes, so an access rule over the note's attributes binds it. The agent
// asked only for the NOTE_UPDATE bit, so the same rule never reached it.
//
// The rule here is a member's own deny on their own notes (createdById is
// them). MEMBER holds NOTE_UPDATE, so only the rule stands in the way, and a
// second member without it is the control on every door.
//
// Own org and own users; the seeded ones are never touched.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import type { Visibility } from "@prisma/client";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
// A title change re-embeds the note; nothing here is about search.
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn().mockResolvedValue(undefined) }));

import { prisma } from "@/lib/db/client";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import type { ToolContext } from "./_ctx";
import { shareNote, updateNote } from "./notes";
import { PUT as noteRoute } from "@/app/api/v1/orgs/[orgId]/notes/[noteId]/route";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const userIds: string[] = [];
let orgId = "";
let restricted: ToolContext;
let control: ToolContext;

/** A note this actor wrote, at this visibility. */
async function noteBy(actor: ToolContext, visibility: Visibility) {
  return (
    await prisma.note.create({ data: { orgId, authorId: actor.userId, title: "Original", content: "", visibility } })
  ).id;
}

const read = (id: string) =>
  prisma.note.findUniqueOrThrow({ where: { id }, select: { title: true, visibility: true } });

async function routeStatus(actor: ToolContext, noteId: string, body: Record<string, unknown>) {
  getAuthContext.mockResolvedValue(actor.auth);
  const res = await noteRoute(
    new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ orgId, noteId }) } as never,
  );
  if (res.status === 200) return { status: 200 };
  const answer = (await res.json()) as { error?: string; detail?: string };
  return { status: res.status, error: answer.error ?? answer.detail };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `nw ${stamp}`, slug: `nw-${stamp}` } })).id;
  /** A MEMBER, with the rules `rules` builds from their own id. */
  const member = async (name: string, rules?: (userId: string) => object[]) => {
    const u = await prisma.user.create({ data: { email: `${name}-${stamp}@example.com`, displayName: name } });
    userIds.push(u.id);
    await prisma.orgMember.create({ data: { orgId, userId: u.id, role: "MEMBER", ...(rules ? { abacRules: rules(u.id) } : {}) } });
    return memberToolCtx(orgId, u.id);
  };
  restricted = await member("restricted", (self) => [
    { effect: "deny", actions: ["NOTE_UPDATE"], conditions: [{ attr: "createdById", op: "eq", value: self }] },
  ]);
  control = await member("control");
}, 120_000);

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe("an access rule over a note binds Cosmo as it binds the app", () => {
  it("the fixture is what it claims: both hold the bit, one carries the rule", () => {
    expect(restricted.auth).toBeDefined();
    expect(control.auth).toBeDefined();
    expect(restricted.auth!.abacRules).toHaveLength(1);
    expect(control.auth!.abacRules).toHaveLength(0);
  });

  it("the route refuses the restricted member and lets the control through", async () => {
    const mine = await noteBy(restricted, "ORG");
    expect(await routeStatus(restricted, mine, { title: "by the route" })).toEqual({
      status: 403,
      error: "Access denied by policy",
    });
    expect(await read(mine)).toEqual({ title: "Original", visibility: "ORG" });

    const theirs = await noteBy(control, "ORG");
    expect((await routeStatus(control, theirs, { title: "by the route" })).status).toBe(200);
    expect((await read(theirs)).title).toBe("by the route");
  });

  it("update_note refuses the restricted member, and edits the control's note", async () => {
    const mine = await noteBy(restricted, "ORG");
    // The route's own words: the refusal comes from the rule, not from the
    // author check or the bit, which this member passes.
    expect(await updateNote({ noteId: mine, title: "by the agent", visibility: "PRIVATE" }, restricted)).toEqual({
      error: "Access denied by policy",
    });
    expect(await read(mine)).toEqual({ title: "Original", visibility: "ORG" });

    const theirs = await noteBy(control, "ORG");
    expect(await updateNote({ noteId: theirs, title: "by the agent", visibility: "PRIVATE" }, control)).toMatchObject({
      updated: true,
    });
    expect(await read(theirs)).toEqual({ title: "by the agent", visibility: "PRIVATE" });
  });

  it("share_note refuses the restricted member, and shares the control's note", async () => {
    const mine = await noteBy(restricted, "PRIVATE");
    expect(await shareNote({ noteId: mine, visibility: "ORG" }, restricted)).toEqual({ error: "Access denied by policy" });
    expect((await read(mine)).visibility).toBe("PRIVATE");

    const theirs = await noteBy(control, "PRIVATE");
    expect(await shareNote({ noteId: theirs, visibility: "ORG" }, control)).toMatchObject({ updated: true, visibility: "ORG" });
    expect((await read(theirs)).visibility).toBe("ORG");
  });
});
