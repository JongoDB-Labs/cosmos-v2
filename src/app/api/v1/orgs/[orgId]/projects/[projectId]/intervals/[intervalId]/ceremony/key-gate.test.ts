// @vitest-environment node
//
// Every ceremony contributor route is a write (add, edit or delete a retro
// note or action item), and requireContributor checked only SPRINT_READ, which
// a `read` key holds: such a key could rewrite or delete anyone's notes and
// action items. A key now needs SPRINT_CREATE (items:write or planning:write);
// a member's session still needs only SPRINT_READ, as the retro room expects.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";

const ORG = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({ getAuthContext: vi.fn(), writes: [] as string[] }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: vi.fn() }));
// The real rule, minus project visibility: the action's bit must be held.
vi.mock("@/lib/rbac/require-project-read", () => ({
  requireProjectRead: async (ctx: AuthContext, _p: string, action: keyof typeof Permission) => {
    if (!hasPermission(ctx.permissions, Permission[action])) throw new ForbiddenError("denied");
  },
}));
vi.mock("@/lib/db/client", () => ({
  // Past the gate, anything touched is recorded; nothing is found, so a call
  // that gets through ends in a 404/400, never the gate's 403.
  prisma: new Proxy({}, {
    get: (_t, model: string) =>
      model === "organization"
        ? { findUnique: async () => ({ id: ORG, slug: "acme" }) }
        : new Proxy({}, { get: (_m, method: string) => async () => { h.writes.push(`${model}.${method}`); return null; } }),
  }),
}));

import { POST as addAction } from "./actions/route";
import { PATCH as editAction, DELETE as deleteAction } from "./actions/[actionId]/route";
import { POST as addNote } from "./notes/route";
import { PATCH as editNote, DELETE as deleteNote } from "./notes/[noteId]/route";

type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
const P = { orgId: ORG, projectId: "p1", intervalId: "i1", actionId: "a1", noteId: "n1" };
const BODY = { ceremonyId: "c1", text: "hi", kind: "WENT_WELL", column: "WENT_WELL" };
const ROUTES: [string, Handler, string][] = [
  ["add an action item", addAction as unknown as Handler, "POST"],
  ["edit an action item", editAction as unknown as Handler, "PATCH"],
  ["delete an action item", deleteAction as unknown as Handler, "DELETE"],
  ["add a note", addNote as unknown as Handler, "POST"],
  ["edit a note", editNote as unknown as Handler, "PATCH"],
  ["delete a note", deleteNote as unknown as Handler, "DELETE"],
];
const call = (handler: Handler, method: string) =>
  handler(
    new NextRequest("http://localhost/x", {
      method, ...(method === "DELETE" ? {} : { body: JSON.stringify(BODY), headers: { "Content-Type": "application/json" } }),
    }),
    { params: Promise.resolve(P) },
  );
const as = (permissions: bigint, scopes?: string[]): AuthContext => ({
  userId: "u1", orgId: ORG, orgRole: OrgRole.OWNER, permissions, basePermissions: permissions, abacRules: [],
  ...(scopes ? { isApiKey: true, scopes } : {}),
});

beforeEach(() => { vi.clearAllMocks(); h.writes.length = 0; });

describe("ceremony writes from a key need SPRINT_CREATE", () => {
  it.each(ROUTES)("an owner's read key can't %s", async (_n, handler, method) => {
    h.getAuthContext.mockResolvedValue(as(scopeMask(["read"]), ["read"]));
    expect((await call(handler, method)).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it.each(ROUTES)("a rules:run key can't %s", async (_n, handler, method) => {
    h.getAuthContext.mockResolvedValue(as(scopeMask(["rules:run"]), ["rules:run"]));
    expect((await call(handler, method)).status).toBe(403);
  });

  it.each(ROUTES)("an items:write key gets past the gate to %s", async (_n, handler, method) => {
    h.getAuthContext.mockResolvedValue(as(scopeMask(["items:write"]), ["items:write"]));
    expect((await call(handler, method)).status).not.toBe(403);
  });

  it.each(ROUTES)("a member's session with only SPRINT_READ still gets past the gate to %s", async (_n, handler, method) => {
    h.getAuthContext.mockResolvedValue({ ...as(Permission.PROJECT_READ | Permission.SPRINT_READ), orgRole: OrgRole.MEMBER });
    expect((await call(handler, method)).status).not.toBe(403);
  });
});
