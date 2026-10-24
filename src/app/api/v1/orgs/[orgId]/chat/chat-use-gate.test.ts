// @vitest-environment node
//
// Chat writes (create a channel or a DM, post, edit or delete a message, pin
// and unpin, react, upload an attachment, run a channel command; and the
// caller's own chat state: join, leave, mark read, notification settings,
// remove a reaction, typing) checked no
// permission bit, so any API key could create channels and post as
// whoever minted it. They now need CHAT_USE, as the Chat page itself does
// (topbar-nav.ts). No scope grants CHAT_USE, so a key never has it; a MEMBER's
// session does, and a VIEWER's never reached chat in the UI.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const ORG = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({ getAuthContext: vi.fn(), writes: [] as string[] }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/db/client", () => ({
  // Anything past the gate records the model it touched; nothing returns data,
  // so a request that gets through ends in a 4xx/5xx that is not the gate's 403.
  prisma: new Proxy({}, {
    get: (_t, model: string) =>
      model === "organization"
        ? { findUnique: async () => ({ id: ORG, slug: "acme" }) }
        : new Proxy({}, { get: (_m, method: string) => async () => { h.writes.push(`${model}.${method}`); return null; } }),
  }),
}));

import { POST as createChannel } from "./channels/route";
import { POST as createDm } from "./dms/route";
import { POST as postMessage } from "./channels/[channelId]/messages/route";
import { POST as upload } from "./attachments/route";
import { PATCH as editMessage, DELETE as deleteMessage } from "./messages/[messageId]/route";
import { POST as pin } from "./channels/[channelId]/pins/route";
import { DELETE as unpin } from "./channels/[channelId]/pins/[messageId]/route";
import { POST as react } from "./messages/[messageId]/reactions/route";
import { POST as runCommand } from "./channels/[channelId]/commands/route";
import { POST as join } from "./channels/[channelId]/join/route";
import { POST as leave } from "./channels/[channelId]/leave/route";
import { POST as markRead } from "./channels/[channelId]/read/route";
import { PATCH as setMyChannelPrefs } from "./channels/[channelId]/members/me/route";
import { DELETE as unreact } from "./messages/[messageId]/reactions/[emoji]/route";
import { POST as typing } from "./channels/[channelId]/typing/route";

type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
const BODY = { name: "c", content: "hi", userIds: [], emoji: "👍", command: "leave", args: "" };
const ROUTES: [string, Handler, Record<string, string>, string][] = [
  ["create a channel", createChannel as unknown as Handler, {}, "POST"],
  ["open a DM", createDm as unknown as Handler, {}, "POST"],
  ["post a message", postMessage as unknown as Handler, { channelId: "ch1" }, "POST"],
  ["upload an attachment", upload as unknown as Handler, {}, "POST"],
  ["edit a message", editMessage as unknown as Handler, { messageId: "m1" }, "PATCH"],
  ["delete a message", deleteMessage as unknown as Handler, { messageId: "m1" }, "DELETE"],
  ["pin a message", pin as unknown as Handler, { channelId: "ch1" }, "POST"],
  ["unpin a message", unpin as unknown as Handler, { channelId: "ch1", messageId: "m1" }, "DELETE"],
  ["react to a message", react as unknown as Handler, { messageId: "m1" }, "POST"],
  ["run /leave", runCommand as unknown as Handler, { channelId: "ch1" }, "POST"],
  // The caller's own chat state is a chat write too (ops' #1137 review): one
  // rule, no list of exceptions to keep straight.
  ["join a channel", join as unknown as Handler, { channelId: "ch1" }, "POST"],
  ["leave a channel", leave as unknown as Handler, { channelId: "ch1" }, "POST"],
  ["mark a channel read", markRead as unknown as Handler, { channelId: "ch1" }, "POST"],
  ["change its channel notification settings", setMyChannelPrefs as unknown as Handler, { channelId: "ch1" }, "PATCH"],
  ["remove a reaction", unreact as unknown as Handler, { messageId: "m1", emoji: "👍" }, "DELETE"],
  ["show as typing", typing as unknown as Handler, { channelId: "ch1" }, "POST"],
];
const call = (handler: Handler, extra: Record<string, string>, method = "POST", body: unknown = BODY) =>
  handler(
    new NextRequest("http://localhost/x", {
      method, ...(method === "DELETE" ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    }),
    { params: Promise.resolve({ orgId: ORG, ...extra }) },
  );
const as = (orgRole: OrgRole, permissions: bigint, over: Partial<AuthContext> = {}): AuthContext => ({
  userId: "u1", orgId: ORG, orgRole, permissions, basePermissions: permissions, abacRules: [], ...over,
});
const MEMBER = Permission.ORG_READ | Permission.CHAT_USE | Permission.PROJECT_READ;

beforeEach(() => {
  vi.clearAllMocks();
  h.writes.length = 0;
});

describe("chat writes need CHAT_USE", () => {
  it.each(ROUTES)("an OWNER's items:write key can't %s", async (_n, handler, extra, method) => {
    // An OWNER's key: the owner's permissions cut to the scope mask, which has no CHAT_USE.
    h.getAuthContext.mockResolvedValue(as(OrgRole.OWNER, Permission.ITEM_CREATE | Permission.ITEM_UPDATE, { isApiKey: true, scopes: ["items:write"] }));
    expect((await call(handler, extra, method)).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it.each(ROUTES)("a VIEWER's session can't %s (the Chat page was never theirs)", async (_n, handler, extra, method) => {
    h.getAuthContext.mockResolvedValue(as(OrgRole.VIEWER, Permission.ORG_READ | Permission.PROJECT_READ));
    expect((await call(handler, extra, method)).status).toBe(403);
  });

  it.each(ROUTES)("a MEMBER's session gets past the gate to %s", async (_n, handler, extra, method) => {
    h.getAuthContext.mockResolvedValue(as(OrgRole.MEMBER, MEMBER));
    expect((await call(handler, extra, method)).status).not.toBe(403);
  });
});

describe("/mute needs CHAT_USE too, like members/me PATCH that sets the same mute", () => {
  it("a VIEWER's session can't mute", async () => {
    h.getAuthContext.mockResolvedValue(as(OrgRole.VIEWER, Permission.ORG_READ | Permission.PROJECT_READ));
    const res = await call(runCommand as unknown as Handler, { channelId: "ch1" }, "POST", { command: "mute", args: "" });
    expect(res.status).toBe(403);
  });

  it("an OWNER's key can't mute", async () => {
    h.getAuthContext.mockResolvedValue(as(OrgRole.OWNER, Permission.ITEM_CREATE | Permission.ITEM_UPDATE, { isApiKey: true, scopes: ["items:write"] }));
    const res = await call(runCommand as unknown as Handler, { channelId: "ch1" }, "POST", { command: "mute", args: "" });
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("a MEMBER's session gets past the gate to mute", async () => {
    h.getAuthContext.mockResolvedValue(as(OrgRole.MEMBER, MEMBER));
    const res = await call(runCommand as unknown as Handler, { channelId: "ch1" }, "POST", { command: "mute", args: "" });
    expect(res.status).not.toBe(403);
  });
});
