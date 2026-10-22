// @vitest-environment node
//
// COSMOS-24 (chat side): the @assistant bubble streams every turn's text, so
// the saved reply must be that same text. Saving only the final turn dropped
// the preamble ("Let me look that up.") the channel had just watched arrive.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, runAgentLoop, publish } = vi.hoisted(() => ({
  prisma: {
    chatChannel: { findUnique: vi.fn(), update: vi.fn() },
    organization: { findUnique: vi.fn() },
    chatMessage: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn() },
  },
  runAgentLoop: vi.fn(),
  publish: vi.fn(async () => {}),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/ai/agent-loop", () => ({ runAgentLoop }));
vi.mock("@/lib/realtime/bus", () => ({ getBus: () => ({ publish }) }));
vi.mock("@/lib/chat/notifications", () => ({ fanOutChatMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/chat/system-message", () => ({ postServerMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/chat/ensure-bots", () => ({
  ensureOrgBots: vi.fn(async () => ({
    assistant: { user: { id: "bot-1" }, toolScope: "FULL", persona: null, model: "sonnet" },
  })),
}));

import { runChatBot } from "./bot-runner";

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

    await runChatBot({ bot: "assistant", orgId: "o1", orgSlug: "acme", channelId: "ch1", invokerUserId: "u1", prompt: "how many?" });

    const saved = prisma.chatMessage.update.mock.calls.at(-1)?.[0] as { data: { content: string } };
    expect(saved.data.content).toBe("Let me look that up.\n\nYou have 2 projects.");
  });
});
