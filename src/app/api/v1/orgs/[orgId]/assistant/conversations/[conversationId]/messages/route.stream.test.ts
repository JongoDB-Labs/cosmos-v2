// @vitest-environment node
//
// COSMOS-24: what the assistant streams, what `done` carries and what is
// saved must be the same text. `done` REPLACES the bubble's content, so when
// it carried only the final turn, a tool run's preamble ("Let me look that
// up.") streamed in and then vanished the moment the answer landed, and the
// reloaded history did not have it either.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { prisma, runAgentLoop, getAuthContext } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    assistantConversation: { findFirst: vi.fn(), update: vi.fn() },
    assistantMessage: { create: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  runAgentLoop: vi.fn(),
  getAuthContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rbac/check", () => ({ requirePermission: vi.fn() }));
vi.mock("@/lib/rate-limit/guard", () => ({ checkRateLimit: vi.fn(() => null) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/ai/assistant-prompt", () => ({ buildAssistantSystemPrompt: () => "sys" }));
vi.mock("@/lib/ai/conversation-title", () => ({
  generateConversationTitle: vi.fn(async () => null),
  DEFAULT_CONVERSATION_TITLE: "New conversation",
}));
vi.mock("@/lib/ai/agent-loop", () => ({ runAgentLoop }));

import { POST } from "./route";

const params = Promise.resolve({ orgId: "o1", conversationId: "c1" });

function streamRequest(accept = "text/event-stream") {
  return new NextRequest("http://localhost/api/v1/orgs/o1/assistant/conversations/c1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", accept },
    body: JSON.stringify({ content: "how many projects?" }),
  });
}

async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const body = await res.text();
  return body
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)));
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockImplementation(async () => ({ userId: "u1", orgId: "o1", orgRole: "MEMBER", permissions: ~0n }));
  prisma.organization.findUnique.mockResolvedValue({ id: "o1", slug: "acme", tenantClass: "COMMERCIAL" });
  prisma.assistantConversation.findFirst.mockResolvedValue({ id: "c1", title: "Projects" });
  prisma.assistantMessage.findMany.mockResolvedValue([{ role: "USER", content: "how many projects?" }]);
  prisma.assistantMessage.create.mockImplementation(async ({ data }: { data: { content: string } }) => ({
    id: "m-" + prisma.assistantMessage.create.mock.calls.length,
    ...data,
  }));
  prisma.user.findUnique.mockResolvedValue({ displayName: "Me" });
});

describe("assistant messages — streaming a tool run", () => {
  it("done and the saved message carry exactly the text that streamed", async () => {
    runAgentLoop.mockImplementation(async ({ onDelta }: { onDelta: (t: string) => void }) => {
      onDelta("Let me look ");
      onDelta("Let me look that up.");
      onDelta("Let me look that up.\n\nYou have ");
      onDelta("Let me look that up.\n\nYou have 2 projects.");
      return {
        text: "You have 2 projects.",
        transcript: "Let me look that up.\n\nYou have 2 projects.",
        toolCalls: [{ id: "t1", name: "list_projects", arguments: {}, result: [] }],
      };
    });

    const events = await readEvents(await POST(streamRequest(), { params }));
    const streamed = events.filter((e) => e.type === "text").map((e) => e.text).join("");
    const done = events.find((e) => e.type === "done");

    expect(streamed).toBe("Let me look that up.\n\nYou have 2 projects.");
    expect(done?.content).toBe(streamed);
    const saved = prisma.assistantMessage.create.mock.calls.at(-1)?.[0] as { data: { role: string; content: string } };
    expect(saved.data.role).toBe("ASSISTANT");
    expect(saved.data.content).toBe(streamed);
  });

  it("sends text that never streamed once, before done", async () => {
    runAgentLoop.mockResolvedValue({
      text: "I couldn't complete that within the tool-call budget.",
      transcript: "I couldn't complete that within the tool-call budget.",
      toolCalls: [],
    });

    const events = await readEvents(await POST(streamRequest(), { params }));
    const texts = events.filter((e) => e.type === "text").map((e) => e.text);

    expect(texts).toEqual(["I couldn't complete that within the tool-call budget."]);
    expect(events.find((e) => e.type === "done")?.content).toBe(texts[0]);
  });
});

// `getAuthContext` accepts API keys, and a key's context is NARROWER than the
// user behind it (permissions ∩ scopes, a project ceiling, no OWNER
// break-glass). The agent's tools are authorised against whatever context this
// route hands the loop — so it must be the caller's own, by identity, not a
// fresh one rebuilt from `userId`.
describe("assistant messages — the agent runs with the caller's AuthContext", () => {
  const keyCtx = {
    userId: "u1", orgId: "o1", orgRole: "OWNER", permissions: 1n, basePermissions: 1n,
    abacRules: [], isApiKey: true, projectScope: ["p-only"],
  };
  const reply = { text: "ok", transcript: "ok", toolCalls: [] };

  it("streaming: passes the exact context getAuthContext returned", async () => {
    getAuthContext.mockResolvedValue(keyCtx);
    runAgentLoop.mockResolvedValue(reply);
    await readEvents(await POST(streamRequest(), { params }));
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    expect(runAgentLoop.mock.calls[0][0].auth).toBe(keyCtx);
    expect(runAgentLoop.mock.calls[0][0].userId).toBe(keyCtx.userId);
  });

  it("blocking: passes the exact context getAuthContext returned", async () => {
    getAuthContext.mockResolvedValue(keyCtx);
    runAgentLoop.mockResolvedValue(reply);
    await POST(streamRequest("application/json"), { params });
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    expect(runAgentLoop.mock.calls[0][0].auth).toBe(keyCtx);
  });
});
