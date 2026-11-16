// @vitest-environment node
//
// The forgot-password request's per-address limit, from a signed-out browser:
// through the real proxy and the real limiter into the route and the database.
// It used to answer 200 once an address had asked too often, so the form said
// a link was on its way when none was sent. Its answer must not depend on
// whether the address has an account.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Seals the reset token for the account that gets mail.
process.env.SSO_VAULT_KEY = Buffer.alloc(32, 37).toString("base64");

const sent = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/integrations/invitation-email", () => ({
  sendPasswordResetEmail: vi.fn(async (p: { toEmail: string }) => {
    sent.push(p.toEmail);
  }),
}));

import { prisma } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { proxy } from "@/proxy";
import { POST } from "./route";

const stamp = Date.now().toString(36);
const address = (n: string) => `zz-pwr-${n}-${stamp}@example.test`;
// Every request comes from a client address of its own, so the per-client
// limit never decides a result here unless a test means it to.
let client = 0;
const clientAddress = () => `198.51.100.${(++client * 7 + Number.parseInt(stamp.slice(-2), 36)) % 250}`;

function browserRequest(email: string, forwardedFor: string) {
  return new NextRequest("http://localhost/api/auth/password/reset/request", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
    },
    body: JSON.stringify({ email }),
  });
}

/** What a signed-out browser gets: the proxy's answer, or the route's when the proxy passes it on. */
async function send(email: string, forwardedFor = clientAddress()): Promise<string> {
  const gate = await proxy(browserRequest(email, forwardedFor));
  const res = gate.headers.get("x-middleware-next") === "1" ? await POST(browserRequest(email, forwardedFor)) : gate;
  return `${res.status} ${await res.text()}`;
}

/** The answers to `n` requests for one address, each from a different client. */
async function answers(email: string, n = 4): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await send(email));
  return out;
}

beforeEach(() => {
  // The shipped default: the client is the right-most X-Forwarded-For entry.
  vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "");
  vi.stubEnv("TRUSTED_PROXY_HOPS", "");
  sent.length = 0;
});

describe("POST /api/auth/password/reset/request: the per-address limit", () => {
  it("answers alike for an address with an account and one without, under the limit and over it", async () => {
    const withAccount = address("has-account");
    const user = await prisma.user.create({
      data: {
        email: withAccount,
        displayName: "Has account",
        passwordHash: hashPassword("reset-limit-pass-1234"),
        passwordSetAt: new Date(),
      },
    });
    try {
      const known = await answers(withAccount);
      const unknown = await answers(address("no-account"));

      expect(known.slice(0, 3)).toEqual(Array(3).fill('200 {"ok":true}'));
      expect(known[3]).toMatch(/^429 /);
      expect(known).toEqual(unknown);
      // Positive control: the account really took the mail path under the
      // limit, and the limit stopped the fourth before any mail went out.
      expect(sent).toEqual(Array(3).fill(withAccount));
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("limits by the address, whatever its case", async () => {
    const email = address("case");
    await answers(email, 3);
    expect(await send(email.toUpperCase())).toMatch(/^429 /);
  });

  it("refuses with the same answer as the per-client limit", async () => {
    const perAddress = (await answers(address("same-body")))[3];
    const edge = clientAddress();
    let perClient = "";
    for (let i = 0; i < 6; i++) perClient = await send(address(`per-client-${i}`), edge);
    expect(perClient).toMatch(/^429 /);
    expect(perAddress).toBe(perClient);
  });
});
