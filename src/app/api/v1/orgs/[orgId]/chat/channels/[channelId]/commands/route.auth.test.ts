// @vitest-environment node
//
// `/ai` and `/notes` start a detached bot run whose tools act as the caller.
// `getAuthContext` accepts API keys, and a key's context is NARROWER than the
// user behind it — so the bot must be handed the caller's own context, by
// identity, rather than one the runner rebuilds from the user id.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { prisma, getAuthContext, runChatBot } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  getAuthContext: vi.fn(),
  runChatBot: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rbac/check", () => ({ requirePermission: vi.fn() }));
vi.mock("@/lib/rate-limit/guard", () => ({ checkRateLimit: vi.fn(() => null) }));
vi.mock("@/lib/chat/access", () => ({
  loadChannelAndMembership: vi.fn(async () => ({
    channel: { id: "ch1", kind: "CHANNEL", name: "general", orgId: "o1", isGeneral: false },
    member: { role: "MEMBER" },
  })),
  canSeeChannelGiven: vi.fn(() => true),
  canManageChannelGiven: vi.fn(() => true),
}));
vi.mock("@/lib/chat/system-message", () => ({ postServerMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/chat/messages", () => ({ createUserMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/realtime/bus", () => ({ getBus: () => ({ publish: vi.fn() }) }));
vi.mock("@/lib/chat/bot-runner", () => ({ runChatBot }));

import { POST } from "./route";

const params = Promise.resolve({ orgId: "o1", channelId: "ch1" });
const keyCtx = {
  userId: "u1", orgId: "o1", orgRole: "OWNER", permissions: 1n, basePermissions: 1n,
  abacRules: [], isApiKey: true, projectScope: ["p-only"],
};

function command(name: string, args = "") {
  return new NextRequest("http://localhost/api/v1/orgs/o1/chat/channels/ch1/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: name, args }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: "o1", slug: "acme" });
  prisma.user.findUnique.mockResolvedValue({ displayName: "Me" });
  getAuthContext.mockResolvedValue(keyCtx);
  runChatBot.mockResolvedValue(undefined);
});

describe("chat commands — bots run under the caller's AuthContext", () => {
  it("/ai forwards the exact context getAuthContext returned", async () => {
    const res = await POST(command("ai", "how many projects?"), { params });
    expect(res.status).toBe(200);
    expect(runChatBot).toHaveBeenCalledTimes(1);
    expect(runChatBot.mock.calls[0][0].invokerAuth).toBe(keyCtx);
    expect(runChatBot.mock.calls[0][0].invokerUserId).toBe("u1");
  });

  it("/notes forwards the exact context getAuthContext returned", async () => {
    const res = await POST(command("notes"), { params });
    expect(res.status).toBe(200);
    expect(runChatBot).toHaveBeenCalledTimes(1);
    expect(runChatBot.mock.calls[0][0].invokerAuth).toBe(keyCtx);
  });
});
