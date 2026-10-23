// COSMOS-202 T1: the bot endpoint refuses anything the Bot Framework didn't
// sign for our app before it touches the database, rate limits by IP, and
// hands a verified activity on.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeBotFramework } from "@/lib/testing/fake-bot-framework";

const APP = "00000000-aaaa-bbbb-cccc-000000000001";
const SVC = "https://smba.trafficmanager.net/amer/";
const handled = vi.fn();

vi.mock("@/lib/integrations/microsoft/teams-app/identity.server", () => ({ teamsBotAppId: async () => APP }));
vi.mock("@/lib/integrations/microsoft/teams-app/handlers.server", () => ({
  tenantOf: (a: { channelData?: { tenant?: { id?: string } } }) => a.channelData?.tenant?.id ?? "",
  handleActivity: async (a: unknown, origin: string) => {
    handled(a, origin);
    return { status: 200, body: { composeExtension: { type: "result", attachments: [] } } };
  },
}));

import { POST } from "./route";
import { _resetBotKeys } from "@/lib/integrations/microsoft/teams-app/bot-auth.server";

let bf: ReturnType<typeof fakeBotFramework>;
let ipN = 0;
const activity = { type: "invoke", name: "composeExtension/query", channelId: "msteams", serviceUrl: SVC, channelData: { tenant: { id: "t1" } } };
function req(auth: string | null, body: unknown = activity, ip = `10.0.0.${++ipN}`) {
  return new NextRequest("http://localhost:3000/api/teams/bot", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip, "x-forwarded-host": "cosmos.example", "x-forwarded-proto": "https", ...(auth ? { authorization: auth } : {}) },
  });
}

describe("POST /api/teams/bot", () => {
  beforeEach(() => {
    _resetBotKeys();
    bf = fakeBotFramework();
    vi.stubGlobal("fetch", bf.fetch);
    handled.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("answers a Bot Framework request for our app, with Cosmos's public origin", async () => {
    const res = await POST(req(bf.token({ aud: APP, serviceUrl: SVC })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ composeExtension: { type: "result", attachments: [] } });
    expect(handled).toHaveBeenCalledWith(expect.objectContaining({ name: "composeExtension/query" }), "https://cosmos.example");
  });

  it("refuses with 401, and handles nothing, when the token is missing, for another bot, or forged", async () => {
    for (const auth of [null, bf.token({ aud: "another-bot", serviceUrl: SVC }), bf.token({ aud: APP, serviceUrl: "https://evil.example/" })]) {
      const res = await POST(req(auth));
      expect(res.status).toBe(401);
    }
    expect(handled).not.toHaveBeenCalled();
  });

  it("never logs the token", async () => {
    const t = bf.token({ aud: "another-bot", serviceUrl: SVC });
    await POST(req(t));
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).toContain("bad_audience");
    expect(logged).not.toContain(t.slice(7, 40));
  });

  it("rejects bodies that aren't JSON, and oversized ones", async () => {
    expect((await POST(req(bf.token({ aud: APP, serviceUrl: SVC }), "{nope"))).status).toBe(400);
    expect((await POST(req(bf.token({ aud: APP, serviceUrl: SVC }), "x".repeat(300 * 1024)))).status).toBe(413);
    expect(handled).not.toHaveBeenCalled();
  });

  it("rate limits each IP before checking anything", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 125; i++) statuses.push((await POST(req(null, activity, "10.9.9.9"))).status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(120);
    expect(statuses.slice(120).every((s) => s === 429)).toBe(true);
  });
});
