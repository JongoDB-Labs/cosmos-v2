// @vitest-environment node
//
// Session ids are stored hashed. The sign-in cookie carries a random token and
// the sessions table keeps only `sessionRowId(token)`, so what is stored can't
// be presented as a cookie. Every door that turns a cookie into a session has
// to hash it the same way: a sign-in, the proxy, getCurrentUser, signing out,
// and the MFA step that upgrades the session it was made from. Against a real
// database; only the TOTP check is stubbed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

process.env.SSO_VAULT_KEY ??= Buffer.alloc(32, 7).toString("base64");

const h = vi.hoisted(() => ({ cookie: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "session" && h.cookie ? { value: h.cookie } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth/totp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/totp")>()),
  verifyTotp: () => true,
}));

import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { sessionRowId } from "@/lib/auth/session-id";
import { finishPasswordLogin } from "@/lib/auth/local-session";
import { getCurrentUser, getSessionUser } from "@/lib/auth/session";
import { sealSecret } from "@/lib/crypto/vault";
import { proxy } from "@/proxy";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as enableMfa } from "@/app/api/v1/me/mfa/enable/route";

const stamp = Math.random().toString(36).slice(2, 8);
let userId = "";

/** Sign in with a password, through the app's own code, and return the cookie. */
async function signIn(): Promise<string> {
  const res = await finishPasswordLogin(NextResponse.json({ ok: true }), { userId, email: `rest-${stamp}@sess.test`, mfaSatisfied: false });
  const token = res.cookies.get(SESSION_COOKIE)?.value;
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  return token!;
}

const storedIds = async () =>
  (await prisma.session.findMany({ where: { userId }, select: { id: true } })).map((s) => s.id);

const page = (cookie: string) =>
  proxy(new NextRequest("http://localhost:3000/some-org/projects", { headers: { host: "localhost:3000", cookie: `${SESSION_COOKIE}=${cookie}` } }));

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `rest-${stamp}@sess.test`, displayName: "At rest" } })).id;
});

beforeEach(async () => {
  h.cookie = null;
  await prisma.session.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("session ids are stored hashed", () => {
  it("a sign-in stores the hash of its cookie, and never the cookie", async () => {
    const token = await signIn();
    const ids = await storedIds();
    expect(ids).toEqual([sessionRowId(token)]);
    expect(ids).not.toContain(token);
  });

  it("the cookie signs in; the stored id does not", async () => {
    const token = await signIn();
    const user = await getSessionUser(token);
    expect(user?.id).toBe(userId);
    // SessionUser.sessionId is the row id: its callers compare it to rows.
    expect(user?.sessionId).toBe(sessionRowId(token));
    expect(await getSessionUser(sessionRowId(token))).toBeNull();

    h.cookie = token;
    expect((await getCurrentUser())?.id).toBe(userId);
  });

  it("the proxy lets the cookie through and sends the stored id to sign in", async () => {
    const token = await signIn();
    const through = await page(token);
    expect(through.headers.get("x-middleware-next")).toBe("1");

    const refused = await page(sessionRowId(token));
    expect(refused.headers.get("x-middleware-next")).toBeNull();
    expect(new URL(refused.headers.get("location") ?? "", "http://x").pathname).toBe("/login");
  });

  it("signing out deletes the session the cookie names", async () => {
    const token = await signIn();
    const other = await signIn();
    expect(await storedIds()).toHaveLength(2); // positive control: both rows are there

    const res = await logout(new NextRequest("http://localhost:3000/api/auth/logout", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
    expect(res.status).toBe(303);
    expect(await storedIds()).toEqual([sessionRowId(other)]);
  });

  it("turning on two-factor upgrades the session it was turned on from", async () => {
    await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecret: sealSecret("JBSWY3DPEHPK3PXP") } });
    const token = await signIn();
    const other = await signIn();
    h.cookie = token;

    const res = await enableMfa(new NextRequest("http://localhost:3000/api/v1/me/mfa/enable", { method: "POST", body: JSON.stringify({ code: "123456" }) }));
    expect(res.status).toBe(200);
    const rows = await prisma.session.findMany({ where: { userId }, select: { id: true, mfaSatisfied: true } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === sessionRowId(token))?.mfaSatisfied).toBe(true);
    expect(rows.find((r) => r.id === sessionRowId(other))?.mfaSatisfied).toBe(false);
  });
});
