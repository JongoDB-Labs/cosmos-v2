// @vitest-environment node
//
// The sign-in page's request-an-account form, end to end from the browser's
// side: through the real proxy, with no session, into the route and the
// database. The proxy used to refuse it with a 401 before the route ever ran,
// while the form showed "sent", so no request was ever stored.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AccountRequestMode } from "@prisma/client";

vi.mock("@/lib/auth/account-requests", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/account-requests")>();
  return { ...real, submitAccountRequest: vi.fn(real.submitAccountRequest) };
});

import { prisma } from "@/lib/db/client";
import { submitAccountRequest } from "@/lib/auth/account-requests";
import { proxy } from "@/proxy";
import { POST } from "./route";

const stamp = Date.now().toString(36);
const slug = `zz-arq-${stamp}`;
const address = (n: string) => `zz-arq-${n}-${stamp}@example.test`;
let orgId = "";
// Each test sends from its own client address, so one test's per-client limit can't throttle another's.
let block = 0;
const clientAddress = () => `203.0.113.${(++block * 7 + Number.parseInt(stamp.slice(-2), 36)) % 250}`;

function browserRequest(body: unknown, forwardedFor: string, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/auth/account-request", {
    method: "POST",
    headers: { host: "localhost", origin, "content-type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify(body),
  });
}

/** What a signed-out browser gets: the proxy's answer, or the route's when the proxy passes the request on. */
async function send(body: unknown, forwardedFor: string, origin?: string): Promise<Response> {
  const gate = await proxy(browserRequest(body, forwardedFor, origin));
  if (gate.headers.get("x-middleware-next") !== "1") return gate;
  return POST(browserRequest(body, forwardedFor, origin));
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `ARQ ${stamp}`, slug } })).id;
  await prisma.orgSecuritySettings.create({ data: { orgId, accountRequestMode: AccountRequestMode.OPEN } });
});

afterAll(async () => {
  await prisma.accountRequest.deleteMany({ where: { orgId } });
  await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

beforeEach(() => {
  // The shipped default: the client is the right-most X-Forwarded-For entry, the one Caddy writes.
  vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "");
  vi.stubEnv("TRUSTED_PROXY_HOPS", "");
  vi.mocked(submitAccountRequest).mockClear();
});

describe("POST /api/auth/account-request from a signed-out browser", () => {
  it("reaches the route through the proxy and is stored for the org's admins", async () => {
    const email = address("stored");
    const res = await send({ orgSlug: slug, email, note: "New on the team" }, clientAddress());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await prisma.accountRequest.findMany({ where: { orgId, email } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PENDING", note: "New on the team", modeAtRequest: AccountRequestMode.OPEN });
  });

  it("is still refused from another site, and stores nothing", async () => {
    const email = address("cross-site");
    const res = await send({ orgSlug: slug, email }, clientAddress(), "https://elsewhere.example");
    expect(res.status).toBe(403);
    expect(await prisma.accountRequest.count({ where: { orgId, email } })).toBe(0);
  });

  it("answers the same whether or not the org exists, takes requests, or the address is valid", async () => {
    const answers = [
      await send({ orgSlug: slug, email: address("same-1") }, clientAddress()),
      await send({ orgSlug: `zz-no-such-org-${stamp}`, email: address("same-2") }, clientAddress()),
      await send({ orgSlug: slug, email: "not an address" }, clientAddress()),
      await send({ nothing: "useful" }, clientAddress()),
    ];
    const seen = await Promise.all(answers.map(async (r) => `${r.status} ${await r.text()}`));
    expect(new Set(seen)).toEqual(new Set(['200 {"ok":true}']));
  });

  it("limits each client by the address the edge wrote, not one the client wrote", async () => {
    // A client can put anything left of the entry Caddy appends; changing it must not buy more tries.
    const edge = clientAddress();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await send({ orgSlug: slug, email: address(`client-${i}`) }, `10.77.${i}.1, ${edge}`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it("limits each address, whichever clients it comes from", async () => {
    const email = address("one-address");
    for (let i = 0; i < 5; i++) {
      expect((await send({ orgSlug: slug, email }, clientAddress())).status).toBe(200);
    }
    // The answer stays the same; only the first few reach the database.
    expect(vi.mocked(submitAccountRequest)).toHaveBeenCalledTimes(3);
  });
});
