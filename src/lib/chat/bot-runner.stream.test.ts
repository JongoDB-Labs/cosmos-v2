// @vitest-environment node
//
// COSMOS-24 (chat side): the @assistant bubble streams every turn's text, so
// the saved reply must be that same text. Saving only the final turn dropped
// the preamble ("Let me look that up.") the channel had just watched arrive.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, runAgentLoop, publish, postServerMessage } = vi.hoisted(() => ({
  prisma: {
    chatChannel: { findUnique: vi.fn(), update: vi.fn() },
    organization: { findUnique: vi.fn() },
    chatMessage: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn() },
  },
  runAgentLoop: vi.fn(),
  publish: vi.fn(async () => {}),
  postServerMessage: vi.fn<(m: { content: string }) => Promise<void>>(async () => {}),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/ai/agent-loop", () => ({ runAgentLoop }));
vi.mock("@/lib/realtime/bus", () => ({ getBus: () => ({ publish }) }));
vi.mock("@/lib/chat/notifications", () => ({ fanOutChatMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/chat/system-message", () => ({ postServerMessage }));
vi.mock("@/lib/chat/ensure-bots", () => ({
  ensureOrgBots: vi.fn(async () => ({
    assistant: { user: { id: "bot-1" }, toolScope: "FULL", persona: null, model: "sonnet" },
    notetaker: { user: { id: "bot-2" }, toolScope: "FULL", persona: null, model: "sonnet" },
    answerer: { user: { id: "bot-3" }, toolScope: "READONLY", persona: null, model: "sonnet" },
  })),
}));

import { runChatBot } from "./bot-runner";
import { stubAuth } from "@/lib/testing/tool-auth";
import { NoModelCredentialError } from "@/lib/ai/egress/types";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.chatChannel.findUnique.mockResolvedValue({
    id: "ch1", kind: "CHANNEL", name: "general", orgId: "o1", projectId: null, topic: null,
  });
  prisma.organization.findUnique.mockResolvedValue({ tenantClass: "COMMERCIAL" });
  prisma.chatMessage.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.findUnique.mockResolvedValue({ displayName: "Me" });
  prisma.chatMessage.create.mockResolvedValue({ id: "m1", authorId: "bot-1", content: "…", kind: "ASSISTANT", createdAt: new Date() });
  prisma.chatMessage.update.mockImplementation(async ({ data }: { data: { content: string } }) => ({
    id: "m1", channelId: "ch1", content: data.content,
  }));
});

describe("runChatBot — @assistant saves what it streamed", () => {
  it("persists the whole transcript, not the final turn alone", async () => {
    runAgentLoop.mockImplementation(async ({ onDelta }: { onDelta: (t: string) => void }) => {
      onDelta("Let me look that up.");
      onDelta("Let me look that up.\n\nYou have 2 projects.");
      return {
        text: "You have 2 projects.",
        transcript: "Let me look that up.\n\nYou have 2 projects.",
        toolCalls: [],
      };
    });

    await runChatBot({ bot: "assistant", orgId: "o1", orgSlug: "acme", channelId: "ch1", invokerUserId: "u1", invokerAuth: stubAuth("o1", "u1"), prompt: "how many?" });

    const saved = prisma.chatMessage.update.mock.calls.at(-1)?.[0] as { data: { content: string } };
    expect(saved.data.content).toBe("Let me look that up.\n\nYou have 2 projects.");
  });
});

// Every bot kind must hand the loop the INVOKER's own AuthContext — for a bot
// summoned through an API key that is the key's narrowed context, so the tools
// cannot act with the full authority of the user behind it.
describe("runChatBot — tools run under the invoker's AuthContext", () => {
  for (const bot of ["assistant", "notetaker", "answerer"] as const) {
    it(`${bot}: forwards invokerAuth to the agent loop by identity`, async () => {
      runAgentLoop.mockResolvedValue({ text: "ok", transcript: "ok", toolCalls: [] });
      const invokerAuth = { ...stubAuth("o1", "u1"), isApiKey: true, projectScope: ["p-only"] };
      await runChatBot({ bot, orgId: "o1", orgSlug: "acme", channelId: "ch1", invokerUserId: "u1", invokerAuth, prompt: "q" });
      expect(runAgentLoop).toHaveBeenCalledTimes(1);
      expect(runAgentLoop.mock.calls[0][0].auth).toBe(invokerAuth);
    });
  }
});

describe("runChatBot — a failed run posts a SYSTEM notice", () => {
  const run = () =>
    runChatBot({ bot: "assistant", orgId: "o1", orgSlug: "acme", channelId: "ch1", invokerUserId: "u1", invokerAuth: stubAuth("o1", "u1"), prompt: "hi" });

  it("says Claude isn't connected when no model credential resolves", async () => {
    runAgentLoop.mockRejectedValue(new NoModelCredentialError());
    await run();
    expect(postServerMessage.mock.calls.at(-1)?.[0].content).toBe(
      "🤖 Claude isn't connected. Connect a Claude subscription in Settings → AI / Model.",
    );
  });

  it("stays generic for any other failure", async () => {
    runAgentLoop.mockRejectedValue(new Error("401 invalid x-api-key"));
    await run();
    expect(postServerMessage.mock.calls.at(-1)?.[0].content).toBe("🤖 AI is unavailable right now.");
  });
});
