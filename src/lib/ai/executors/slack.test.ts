// @vitest-environment node
//
// Slack executor — locks the connector contract:
//   - resolves the org-SHARED sealed bot token via getOrgCredential(orgId,'slack')
//     ({ botToken }) + the non-secret defaultChannel from config;
//   - "not connected" → graceful { error }, never a throw;
//   - Slack's HTTP-200 { ok:false, error } → graceful, TOKEN-FREE { error };
//   - success → a shallow shape (text INCLUDED — the egress gate, not the executor,
//     decides what the model sees);
//   - the Bearer token is sent to the API but NEVER appears in any returned value.
// Uses an INJECTED fetch (ctx.fetchImpl) so no network is touched.
//
// Plus a PROJECTION CONTRACT assertion: a gov slack_message is projected to
// structural-only (ts/channel/user/type), with `text` NEVER exposed.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getOrgCredential, prisma } = vi.hoisted(() => ({
  getOrgCredential: vi.fn(),
  prisma: { integration: { findFirst: vi.fn() } },
}));

vi.mock("@/lib/integrations/credentials", () => ({ getOrgCredential }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  slackListChannels,
  slackSearchMessages,
  slackPostMessage,
  SLACK_TOOL_NAMES,
  executeSlackTool,
} from "./slack";
import { projectStructural } from "../egress/projection";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const USER = "00000000-0000-0000-0000-0000000000bb";
const TOKEN = "xoxb-TESTTOKEN";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrgCredential.mockResolvedValue({ botToken: TOKEN });
  prisma.integration.findFirst.mockResolvedValue({ config: { defaultChannel: "C0DEFAULT" } });
});

describe("not connected (no sealed org credential)", () => {
  it("slack_list_channels returns a graceful error, never throws", async () => {
    getOrgCredential.mockResolvedValue(null);
    const fetchImpl = mockFetch(200, { ok: true, channels: [] });
    const res = (await slackListChannels({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("Slack is not connected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a present-but-tokenless bundle as not connected", async () => {
    getOrgCredential.mockResolvedValue({});
    const res = (await slackSearchMessages({ query: "x" }, { orgId: ORG, userId: USER, fetchImpl: mockFetch(200, { ok: true }) })) as {
      error?: string;
    };
    expect(res.error).toContain("Slack is not connected");
  });
});

describe("slackListChannels (success)", () => {
  it("calls conversations.list with the Bearer token, returns a shallow shape", async () => {
    const fetchImpl = mockFetch(200, {
      ok: true,
      channels: [
        { id: "C123", name: "ops-secret", is_private: false, is_archived: false, created: 1700000000 },
      ],
    });
    const res = (await slackListChannels({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      success: boolean;
      count: number;
      channels: Array<Record<string, unknown>>;
    };

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("https://slack.com/api/conversations.list");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(res.count).toBe(1);
    expect(res.channels[0]).toMatchObject({ id: "C123", is_private: false, is_archived: false, created: 1700000000 });
    // The token never appears in the returned value.
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});

describe("slackSearchMessages (success)", () => {
  it("calls search.messages, normalizes channel object→id, includes text (gate withholds it)", async () => {
    const fetchImpl = mockFetch(200, {
      ok: true,
      messages: {
        matches: [
          { ts: "1700000000.000100", channel: { id: "C123", name: "ops" }, user: "U456", type: "message", text: "CUI//SP exfil" },
        ],
      },
    });
    const res = (await slackSearchMessages({ query: "deploy" }, { orgId: ORG, userId: USER, fetchImpl })) as {
      count: number;
      messages: Array<Record<string, unknown>>;
    };
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toContain("https://slack.com/api/search.messages");
    expect(url).toContain("query=deploy");
    expect(res.count).toBe(1);
    expect(res.messages[0]).toMatchObject({
      ts: "1700000000.000100",
      channel: "C123", // object normalized to its id
      user: "U456",
      type: "message",
      text: "CUI//SP exfil",
    });
  });

  it("requires a query", async () => {
    const res = (await slackSearchMessages({}, { orgId: ORG, userId: USER, fetchImpl: mockFetch(200, { ok: true }) })) as {
      error?: string;
    };
    expect(res.error).toContain("query");
  });
});

describe("slackPostMessage (the one write)", () => {
  it("POSTs to chat.postMessage with the default channel, returns ts/channel only", async () => {
    const fetchImpl = mockFetch(200, { ok: true, ts: "1700000000.000200", channel: "C0DEFAULT" });
    const res = (await slackPostMessage({ text: "hello" }, { orgId: ORG, userId: USER, fetchImpl })) as {
      success: boolean;
      message: Record<string, unknown>;
    };
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("https://slack.com/api/chat.postMessage");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const sent = JSON.parse(init.body as string);
    expect(sent.channel).toBe("C0DEFAULT"); // default channel
    expect(sent.text).toBe("hello");
    // The write returns ONLY ts + channel.
    expect(res.message).toEqual({ ts: "1700000000.000200", channel: "C0DEFAULT" });
  });

  it("requires text + a channel (when no default)", async () => {
    const r1 = (await slackPostMessage({}, { orgId: ORG, userId: USER, fetchImpl: mockFetch(200, { ok: true }) })) as { error?: string };
    expect(r1.error).toContain("text");

    prisma.integration.findFirst.mockResolvedValue({ config: {} });
    const r2 = (await slackPostMessage({ text: "hi" }, { orgId: ORG, userId: USER, fetchImpl: mockFetch(200, { ok: true }) })) as { error?: string };
    expect(r2.error).toContain("channel");
  });
});

describe("Slack logical-failure handling (ok:false → graceful, token-free)", () => {
  it("an HTTP-200 { ok:false, error } becomes a clean error with no token leak", async () => {
    const fetchImpl = mockFetch(200, { ok: false, error: "invalid_auth" });
    const res = (await slackListChannels({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("invalid_auth");
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("an HTTP 5xx becomes a graceful error", async () => {
    const fetchImpl = mockFetch(500, "Server Error");
    const res = (await slackSearchMessages({ query: "x" }, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("HTTP 500");
  });

  it("a thrown fetch (network failure) is caught → graceful error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = (await slackListChannels({}, { orgId: ORG, userId: USER, fetchImpl })) as {
      error?: string;
    };
    expect(res.error).toContain("ECONNREFUSED");
  });
});

describe("dispatch", () => {
  it("SLACK_TOOL_NAMES lists exactly the three tools", () => {
    expect([...SLACK_TOOL_NAMES].sort()).toEqual(
      ["slack_list_channels", "slack_post_message", "slack_search_messages"].sort(),
    );
  });

  it("executeSlackTool returns null for a non-slack tool", async () => {
    expect(await executeSlackTool("send_email", {}, { orgId: ORG, userId: USER })).toBeNull();
  });
});

describe("PROJECTION CONTRACT — a gov slack_message is structural-only (NO text)", () => {
  it("projects ts/channel/user/type; text NEVER exposed", () => {
    const msg = { ts: "1700000000.000100", channel: "C123", user: "U456", type: "message", text: "CUI//SP exfil path" };
    const mv = projectStructural(msg, "slack_message") as Record<string, unknown>;
    expect(mv).toEqual({ ts: "1700000000.000100", channel: "C123", user: "U456", type: "message" });
    expect("text" in mv).toBe(false);
    expect(JSON.stringify(mv)).not.toContain("CUI");
  });

  it("a gov slack_channel exposes id/is_private/is_archived/created; name WITHHELD", () => {
    const ch = { id: "C123", name: "ops-secret", is_private: true, is_archived: false, created: 1700000000 };
    const mv = projectStructural(ch, "slack_channel") as Record<string, unknown>;
    expect(mv).toEqual({ id: "C123", is_private: true, is_archived: false, created: 1700000000 });
    expect(JSON.stringify(mv)).not.toContain("secret");
  });
});
