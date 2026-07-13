// @vitest-environment node
//
// End-to-end forced first-login onboarding for an email/password invite, driven
// through the REAL route handlers + REAL e2e DB. Only the gov-SSO guard and the
// rate limiter are stubbed (deterministic); every credential/session write is
// real. Proves the security contract:
//   - a freshly-provisioned invitee CANNOT get a session with the temp password
//     (login returns next:"change_password" and sets NO session cookie);
//   - the new password must differ from the temporary one;
//   - after the change (no MFA) a session is minted;
//   - when the invite required MFA, the flow forces TOTP enrollment and the final
//     session is mfaSatisfied.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

// Vault key for sealing the first-login / MFA-pending cookies + the TOTP secret.
process.env.SSO_VAULT_KEY = Buffer.alloc(32, 11).toString("base64");

vi.mock("@/lib/auth/sso-enforcement", () => ({
  googleLoginBlockedByGovSso: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/rate-limit/bucket", () => ({
  rateLimit: () => ({ allowed: true }),
}));

import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { FIRST_LOGIN_COOKIE } from "@/lib/auth/first-login";
import { provisionEmailPasswordInvite } from "@/lib/auth/invite-credentials";
import { POST as login } from "../login/route";
import { POST as changePassword } from "./change/route";
import { POST as mfaSetup } from "./mfa-setup/route";
import { POST as mfaEnroll } from "./mfa-enroll/route";

const E_SIMPLE = "zz-fl-simple@example.com";
const E_SAME = "zz-fl-same@example.com";
const E_MFA = "zz-fl-mfa@example.com";
const E_ORDER = "zz-fl-order@example.com";
const NEW_PASSWORD = "brand-new-passphrase-9x";

// Compute the current TOTP the same way src/lib/auth/totp.ts verifies it.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of clean) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totpNow(secret: string): string {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** 6).toString().padStart(6, "0");
}

function req(body: unknown, cookies: Record<string, string> = {}): NextRequest {
  const r = new NextRequest("http://localhost/api/auth/password", {
    method: "POST",
    body: JSON.stringify(body),
  });
  for (const [k, v] of Object.entries(cookies)) r.cookies.set(k, v);
  return r;
}

async function cleanup() {
  const emails = [E_SIMPLE, E_SAME, E_MFA, E_ORDER];
  await prisma.session.deleteMany({ where: { user: { email: { in: emails } } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

beforeAll(cleanup);
afterAll(cleanup);

describe("forced first-login: password change (no MFA)", () => {
  it("refuses a session on the temp password and mints one only after the change", async () => {
    const { tempPassword } = await provisionEmailPasswordInvite({
      email: E_SIMPLE,
      mfaRequired: false,
    });
    expect(tempPassword).toBeTruthy();

    // Step 1: sign in with the temp password → forced to change, NO session yet.
    const loginRes = await login(req({ email: E_SIMPLE, password: tempPassword }));
    expect(loginRes.status).toBe(200);
    expect(await loginRes.json()).toMatchObject({ next: "change_password" });
    expect(loginRes.cookies.get(SESSION_COOKIE)).toBeUndefined();
    const flCookie = loginRes.cookies.get(FIRST_LOGIN_COOKIE)?.value;
    expect(flCookie).toBeTruthy();

    // Step 2: set a new password → session minted.
    const changeRes = await changePassword(
      req({ newPassword: NEW_PASSWORD }, { [FIRST_LOGIN_COOKIE]: flCookie as string }),
    );
    expect(changeRes.status).toBe(200);
    expect(await changeRes.json()).toMatchObject({ ok: true });
    expect(changeRes.cookies.get(SESSION_COOKIE)?.value).toBeTruthy();

    const user = await prisma.user.findFirstOrThrow({ where: { email: E_SIMPLE } });
    expect(user.mustChangePassword).toBe(false);
  });

  it("rejects a new password equal to the temporary one", async () => {
    const { tempPassword } = await provisionEmailPasswordInvite({
      email: E_SAME,
      mfaRequired: false,
    });
    const loginRes = await login(req({ email: E_SAME, password: tempPassword }));
    const flCookie = loginRes.cookies.get(FIRST_LOGIN_COOKIE)?.value as string;

    const res = await changePassword(
      req({ newPassword: tempPassword }, { [FIRST_LOGIN_COOKIE]: flCookie }),
    );
    expect(res.status).toBe(400);
    expect(loginRes.cookies.get(SESSION_COOKIE)).toBeUndefined();
    // Still must-change until they pick a different password.
    const user = await prisma.user.findFirstOrThrow({ where: { email: E_SAME } });
    expect(user.mustChangePassword).toBe(true);
  });
});

describe("forced first-login: MFA required", () => {
  it("forces TOTP enrollment and mints an mfaSatisfied session", async () => {
    const { tempPassword } = await provisionEmailPasswordInvite({
      email: E_MFA,
      mfaRequired: true,
    });

    // Login → change_password first (rotation always precedes MFA).
    const loginRes = await login(req({ email: E_MFA, password: tempPassword }));
    expect(await loginRes.json()).toMatchObject({ next: "change_password", mfaRequired: true });
    let flCookie = loginRes.cookies.get(FIRST_LOGIN_COOKIE)?.value as string;

    // Change password → now owes MFA enrollment, still NO session.
    const changeRes = await changePassword(
      req({ newPassword: NEW_PASSWORD }, { [FIRST_LOGIN_COOKIE]: flCookie }),
    );
    expect(await changeRes.json()).toMatchObject({ next: "enroll_mfa" });
    expect(changeRes.cookies.get(SESSION_COOKIE)).toBeUndefined();
    // The change endpoint keeps the first-login cookie alive.
    flCookie = changeRes.cookies.get(FIRST_LOGIN_COOKIE)?.value ?? flCookie;

    // Begin enrollment → get the pending secret.
    const setupRes = await mfaSetup(req({}, { [FIRST_LOGIN_COOKIE]: flCookie }));
    expect(setupRes.status).toBe(200);
    const { secret } = (await setupRes.json()) as { secret: string };
    expect(secret).toBeTruthy();

    // Finalize with a real code → mfaSatisfied session + one-time recovery codes.
    const enrollRes = await mfaEnroll(
      req({ code: totpNow(secret) }, { [FIRST_LOGIN_COOKIE]: flCookie }),
    );
    expect(enrollRes.status).toBe(200);
    const enrollBody = (await enrollRes.json()) as { ok: boolean; recoveryCodes: string[] };
    expect(enrollBody.ok).toBe(true);
    expect(enrollBody.recoveryCodes.length).toBeGreaterThan(0);

    const sessionId = enrollRes.cookies.get(SESSION_COOKIE)?.value;
    expect(sessionId).toBeTruthy();
    const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId as string } });
    expect(session.mfaSatisfied).toBe(true);

    const user = await prisma.user.findFirstOrThrow({ where: { email: E_MFA } });
    expect(user.mfaEnabled).toBe(true);
    expect(user.mustChangePassword).toBe(false);
  });

  it("blocks MFA enrollment until the password has been changed (ordering)", async () => {
    // Fresh invite still owing the password change (distinct email for isolation).
    const { tempPassword } = await provisionEmailPasswordInvite({
      email: E_ORDER,
      mfaRequired: true,
    });
    const loginRes = await login(req({ email: E_ORDER, password: tempPassword }));
    const flCookie = loginRes.cookies.get(FIRST_LOGIN_COOKIE)?.value as string;

    const setupRes = await mfaSetup(req({}, { [FIRST_LOGIN_COOKIE]: flCookie }));
    expect(setupRes.status).toBe(400); // "set your new password first"
  });
});
