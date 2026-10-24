// COSMOS-202 T1: the Bot Framework request check. Every rule in Microsoft's
// list is a test here, each by breaking just that one part of a good request.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { fakeBotFramework } from "@/lib/testing/fake-bot-framework";
import { BotAuthError, _resetBotKeys, verifyBotRequest } from "./bot-auth.server";

const APP = "00000000-aaaa-bbbb-cccc-000000000001";
const SVC = "https://smba.trafficmanager.net/amer/";
const activity = { channelId: "msteams", serviceUrl: SVC };

describe("verifyBotRequest", () => {
  let bf: ReturnType<typeof fakeBotFramework>;
  let now: number;
  const deps = () => ({ fetch: bf.fetch, now: () => now });
  const reason = async (auth: string | null, act: object = activity) => {
    try {
      await verifyBotRequest(auth, act, APP, deps());
      return "ok";
    } catch (e) {
      if (e instanceof BotAuthError) return e.reason;
      throw e;
    }
  };
  const good = (claims: object = {}, o: Parameters<typeof bf.token>[1] = {}) =>
    bf.token({ aud: APP, serviceUrl: SVC, ...claims }, { nowS: Math.floor(now / 1000), ...o });

  beforeEach(() => {
    _resetBotKeys();
    bf = fakeBotFramework();
    now = Date.parse("2026-10-23T12:00:00Z");
  });

  it("accepts a Bot Framework token for our app that covers this activity", async () => {
    expect(await reason(good())).toBe("ok");
    expect(await reason(good({ aud: [APP] }))).toBe("ok");
  });

  it("needs a Bearer token", async () => {
    expect(await reason(null)).toBe("no_token");
    expect(await reason(good().replace("Bearer ", "Basic "))).toBe("no_token");
  });

  it("only RS256, so an alg:none or HMAC token is refused before any key lookup", async () => {
    expect(await reason(good({}, { alg: "none" }))).toBe("bad_alg");
    expect(await reason(good({}, { alg: "HS256" }))).toBe("bad_alg");
    expect(bf.state.fetches).toBe(0);
  });

  it("refuses a signature made with any other key, even under a published key id", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(await reason(good({}, { key: privateKey }))).toBe("bad_signature");
  });

  it("refuses a tampered payload", async () => {
    const [scheme, t] = good().split(" ");
    const [h, , s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ iss: "https://api.botframework.com", aud: APP, serviceUrl: SVC, exp: now / 1000 + 3600 })).toString("base64url");
    expect(await reason(`${scheme} ${h}.${forged}.${s}`)).toBe("bad_signature");
  });

  it("needs the key to endorse Teams, and the activity to be from Teams", async () => {
    bf = fakeBotFramework({ endorsements: ["webchat"] });
    expect(await reason(good())).toBe("not_endorsed");
    _resetBotKeys();
    bf = fakeBotFramework();
    expect(await reason(good(), { ...activity, channelId: "webchat" })).toBe("bad_channel");
  });

  it("checks issuer and audience", async () => {
    expect(await reason(good({ iss: "https://sts.windows.net/x/" }))).toBe("bad_issuer");
    expect(await reason(good({ aud: "someone-elses-bot" }))).toBe("bad_audience");
    expect(await reason(good({ aud: [APP, "other"] }))).toBe("bad_audience");
  });

  it("allows five minutes of clock skew, no more", async () => {
    const t = Math.floor(now / 1000);
    expect(await reason(good({ exp: t - 299 }))).toBe("ok");
    expect(await reason(good({ exp: t - 301 }))).toBe("expired");
    expect(await reason(good({ nbf: t + 299 }))).toBe("ok");
    expect(await reason(good({ nbf: t + 301 }))).toBe("not_yet_valid");
  });

  it("needs the serviceUrl claim to match the activity's", async () => {
    expect(await reason(good({ serviceUrl: "https://smba.trafficmanager.net/amer" }))).toBe("ok"); // trailing slash only
    expect(await reason(good({ serviceUrl: "https://evil.example/" }))).toBe("bad_service_url");
    expect(await reason(good({ serviceUrl: undefined }))).toBe("bad_service_url");
  });

  it("caches the key set, refetches on a rotated key, and is not made to refetch by made-up key ids", async () => {
    expect(await reason(good())).toBe("ok");
    expect(await reason(good())).toBe("ok");
    expect(bf.state.fetches).toBe(1);
    now += 6 * 60_000;
    bf.rotate("k2");
    expect(await reason(good({}, { kid: "k2" }))).toBe("ok");
    expect(bf.state.fetches).toBe(2);
    for (let i = 0; i < 5; i++) expect(await reason(good({}, { kid: `made-up-${i}` }))).toBe("unknown_key");
    expect(bf.state.fetches).toBe(2);
  });

  it("refreshes at least daily, and keeps the old keys through an outage", async () => {
    expect(await reason(good())).toBe("ok");
    now += 25 * 3600_000;
    bf.state.down = true;
    expect(await reason(good())).toBe("ok");
    bf.state.down = false;
    now += 6 * 60_000;
    expect(await reason(good())).toBe("ok");
    expect(bf.state.fetches).toBe(2);
  });

  it("stops trusting a key set it couldn't refresh for twice its refresh age", async () => {
    expect(await reason(good())).toBe("ok");
    bf.state.down = true;
    now += 47 * 3600_000;
    expect(await reason(good())).toBe("ok");
    now += 2 * 3600_000;
    expect(await reason(good())).toBe("keys_expired");
    bf.state.down = false;
    now += 6 * 60_000;
    expect(await reason(good())).toBe("ok"); // refreshed, trusted again
  });

  it("looks the app id up only after the signature, issuer, window and serviceUrl check out", async () => {
    const lookup = vi.fn(async () => APP);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const bad of [null, good({}, { key: privateKey }), good({ iss: "x" }), good({ exp: 1 }), good({ serviceUrl: "https://evil.example/" })]) {
      await expect(verifyBotRequest(bad, activity, lookup, deps())).rejects.toBeInstanceOf(BotAuthError);
    }
    expect(lookup).not.toHaveBeenCalled();
    await verifyBotRequest(good(), activity, lookup, deps());
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(verifyBotRequest(good(), activity, async () => null, deps())).rejects.toMatchObject({ reason: "not_configured" });
  });

  it("with no keys at all and the key endpoint down, refuses", async () => {
    bf.state.down = true;
    expect(await reason(good())).toBe("keys_unavailable");
  });
});
