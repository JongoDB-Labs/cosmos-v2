// @vitest-environment node
//
// The pieces of Slack notifications that need no database: the install
// state's lifetime, where Slack may be reached, and what a message can say.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

process.env.SSO_VAULT_KEY = Buffer.alloc(32, 3).toString("base64");
delete process.env.SSO_VAULT_KEYS;
delete process.env.SSO_VAULT_ACTIVE_KID;

const { newInstallState, openInstallState, _resetUsedInstallStates } = await import("./oauth.server");
const { slackOrigin, slackAppConfig, SLACK_SCOPES } = await import("./config");
const { buildSlackMessage } = await import("./message");
const { SlackApiError, slackApi } = await import("./web-api.server");

beforeEach(() => _resetUsedInstallStates());

describe("install state", () => {
  it("opens once, for its own state, until it expires", () => {
    const t = 1_000_000;
    const a = newInstallState("org", "user", "https://cosmos.example.com", t);
    expect(openInstallState(a.cookie, a.state, t + 9 * 60_000)).toMatchObject({ orgId: "org", userId: "user", origin: "https://cosmos.example.com" });
    expect(openInstallState(a.cookie, a.state, t + 9 * 60_000)).toBeNull(); // used

    const b = newInstallState("org", "user", "https://cosmos.example.com", t);
    expect(openInstallState(b.cookie, b.state, t + 11 * 60_000)).toBeNull(); // expired
    const c = newInstallState("org", "user", "https://cosmos.example.com", t);
    expect(openInstallState(c.cookie, b.state, t)).toBeNull(); // someone else's state
    expect(openInstallState(undefined, c.state, t)).toBeNull();
    expect(openInstallState("v2.v1.garbage", c.state, t)).toBeNull();
    expect(openInstallState(c.cookie, c.state, t)).not.toBeNull(); // the positive control
  });
});

describe("configuration", () => {
  it("asks for exactly the bot scopes of the app manifest operators install from", () => {
    // The runbook's manifest is the app definition; an install granting more
    // or less than it is refused, so the two lists must be the same.
    const doc = readFileSync("docs/runbooks/slack-notifications.md", "utf8");
    const manifest = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1] ?? "";
    const bot = /scopes:\n\s+bot:\n((?:\s+- .+\n)+)/.exec(manifest)?.[1] ?? "";
    const listed = bot.split("\n").map((l) => l.trim().replace(/^- /, "")).filter(Boolean);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toEqual([...SLACK_SCOPES]);
  });

  it("Slack is reached over https, or plain http only on this machine", () => {
    expect(slackOrigin({})).toBe("https://slack.com");
    expect(slackOrigin({ SLACK_API_ORIGIN: "http://localhost:4111/" })).toBe("http://localhost:4111");
    expect(slackOrigin({ SLACK_API_ORIGIN: "https://slack-proxy.example.com" })).toBe("https://slack-proxy.example.com");
    expect(slackOrigin({ SLACK_API_ORIGIN: "http://slack-proxy.example.com" })).toBe("https://slack.com");
    expect(slackOrigin({ SLACK_API_ORIGIN: "not a url" })).toBe("https://slack.com");
  });

  it("the app is configured only with both values", () => {
    expect(slackAppConfig({ SLACK_CLIENT_ID: "a" })).toBeNull();
    expect(slackAppConfig({ SLACK_CLIENT_ID: " a ", SLACK_CLIENT_SECRET: "b" })).toEqual({ clientId: "a", clientSecret: "b" });
  });
});

describe("the message", () => {
  it("is the key as a link and the title, escaped so nothing in it becomes markup, a link or a mention", () => {
    const m = buildSlackMessage({ type: "assigned", key: "ACME-7", title: "Fix <!channel> & <https://evil.example|this>", url: "https://cosmos.example.com/acme/work-items?item=1" });
    expect(m.text).toBe("Assigned to you: ACME-7 Fix &lt;!channel&gt; &amp; &lt;https://evil.example|this&gt;");
    expect(m.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "*Assigned to you*\n<https://cosmos.example.com/acme/work-items?item=1|ACME-7> Fix &lt;!channel&gt; &amp; &lt;https://evil.example|this&gt;" } }]);
  });

  it("says Restricted in place of a title it may not carry, and a link can't break out of its brackets", () => {
    const m = buildSlackMessage({ type: "mentioned", key: "ACME-7", title: null, url: "https://cosmos.example.com/a b|c>d" });
    expect(m.text).toBe("You were mentioned: ACME-7 Restricted");
    expect(JSON.stringify(m.blocks)).toContain("<https://cosmos.example.com/a%20b%7Cc%3Ed|ACME-7> Restricted");
  });
});

describe("calling Slack", () => {
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

  it("turns every kind of refusal into a code, and nothing else", async () => {
    const call = (f: typeof fetch) => slackApi("chat.postMessage", { bearer: "xoxb-1" }, {}, { fetch: f }).catch((e) => e);
    expect(await call(answer(200, { ok: false, error: "channel_not_found" }))).toMatchObject({ code: "channel_not_found", retryable: false });
    expect(await call(answer(429, {}, { "Retry-After": "7" }))).toMatchObject({ code: "ratelimited", retryAfterMs: 7000, retryable: true });
    expect(await call(answer(502, "<html>"))).toMatchObject({ code: "http_502", retryable: true });
    expect(await call(answer(200, "not json"))).toMatchObject({ code: "bad_response" });
    expect(await call(answer(200, { ok: false, error: "<script>x</script> and a token xoxb-123" }))).toMatchObject({ code: "unknown_error" });
    expect(await call((async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch)).toMatchObject({ code: "network", retryable: true });
    expect(new SlackApiError("token_revoked", 200).tokenDead).toBe(true);
    expect(await slackApi("auth.test", { bearer: "xoxb-1" }, {}, { fetch: answer(200, { ok: true, team: "T" }) })).toEqual({ ok: true, team: "T" });
  });
});
