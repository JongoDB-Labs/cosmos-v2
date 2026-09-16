// @vitest-environment node
//
// COSMOS-24 — the assistant SSE stream must deliver the model's text at the
// granularity the model produced it.
//
// `runAgentLoop`'s `onDelta` carries the CUMULATIVE text of the CURRENT turn and
// restarts at "" on every turn, so a tool-using run streams a preamble in turn 0
// and the answer in turn 1. The route used to slice every turn at ONE running
// offset: turn 1's early deltas (shorter than the preamble) were dropped outright
// and the first longer one was emitted head-truncated — silence, then one lump.
// These tests pin both halves: nothing is lost, and nothing is coalesced.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit, runAgentLoop } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    assistantConversation: { findFirst: vi.fn(), update: vi.fn() },
    assistantMessage: { create: vi.fn(), findMany: vi.fn() },
  },
  logAudit: vi.fn(),
  runAgentLoop: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/ai/agent-loop", () => ({ runAgentLoop }));
// Titling runs its own model call through the egress chokepoint; stub it out so
// this test only exercises the stream. The conversation below is already titled,
// so the route short-circuits before calling it anyway.
vi.mock("@/lib/ai/conversation-title", () => ({
  generateConversationTitle: vi.fn(async () => null),
  DEFAULT_CONVERSATION_TITLE: "New conversation",
}));

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "44444444-4444-4444-4444-444444444444";
const params = Promise.resolve({ orgId: ORG_ID, conversationId: CONVERSATION_ID });

// The tool-use preamble (turn 0) and the real answer (turn 1), each as the
// cumulative snapshots the loop hands to `onDelta`.
const PREAMBLE_STEPS = ["Let me ", "Let me look ", "Let me look that up."];
const ANSWER = "You have two projects: Apollo and Borealis.";
const ANSWER_STEPS = [
  "You ",
  "You have ",
  "You have two ",
  ANSWER,
];

function ctx(): AuthContext {
  const perms = Permission.CHAT_USE;
  return {
    userId: USER_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.ADMIN,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}

function streamRequest() {
  return new NextRequest(
    `http://localhost/api/v1/orgs/${ORG_ID}/assistant/conversations/${CONVERSATION_ID}/messages`,
    {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: JSON.stringify({ content: "how many projects do I have?" }),
    },
  );
}

/** Drain the SSE body into its parsed events, in order. */
async function readEvents(res: Response): Promise<Record<string, unknown>[]> {
  const body = await res.text();
  return body
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(ctx());
  prisma.organization.findUnique.mockResolvedValue({
    id: ORG_ID,
    slug: `acme-${Math.random().toString(36).slice(2)}`,
    tenantClass: "COMMERCIAL",
  });
  prisma.user.findUnique.mockResolvedValue({ displayName: "Ada" });
  prisma.assistantConversation.findFirst.mockResolvedValue({
    id: CONVERSATION_ID,
    // Already titled ⇒ the auto-title path short-circuits.
    title: "Project questions",
  });
  prisma.assistantConversation.update.mockResolvedValue({ id: CONVERSATION_ID });
  prisma.assistantMessage.findMany.mockResolvedValue([]);
  prisma.assistantMessage.create.mockResolvedValue({ id: "msg-1" });

  // A two-turn run: a preamble, then (after tools) the answer — each cumulative
  // from "", exactly as the loop emits them.
  runAgentLoop.mockImplementation(
    async (opts: { onDelta?: (textSoFar: string) => void }) => {
      for (const step of PREAMBLE_STEPS) opts.onDelta?.(step);
      for (const step of ANSWER_STEPS) opts.onDelta?.(step);
      return { text: ANSWER, toolCalls: [] };
    },
  );
});

describe("assistant message stream — fluidity", () => {
  it("streams every delta of a post-tool turn, with nothing dropped", async () => {
    const events = await readEvents(await POST(streamRequest(), { params }));
    const streamed = events
      .filter((e) => e.type === "text")
      .map((e) => e.text as string)
      .join("");

    // The preamble AND the answer arrive whole — no head chopped off the answer
    // because the previous turn happened to be longer.
    expect(streamed).toBe(PREAMBLE_STEPS[2] + ANSWER);
  });

  it("emits one SSE text event per model delta (no coalescing)", async () => {
    const events = await readEvents(await POST(streamRequest(), { params }));
    const texts = events.filter((e) => e.type === "text");

    expect(texts).toHaveLength(PREAMBLE_STEPS.length + ANSWER_STEPS.length);
    expect(texts.map((e) => e.text)).toEqual([
      "Let me ",
      "look ",
      "that up.",
      "You ",
      "have ",
      "two ",
      "projects: Apollo and Borealis.",
    ]);
  });

  it("finishes with a done event carrying the answer and its latency shape", async () => {
    const events = await readEvents(await POST(streamRequest(), { params }));
    const done = events.find((e) => e.type === "done");

    expect(done).toBeDefined();
    expect(done!.content).toBe(ANSWER);
    // Timing is counts + milliseconds only: one entry per forwarded delta, and
    // the character total of everything streamed.
    const timing = done!.timing as { deltas: number; chars: number };
    expect(timing.deltas).toBe(PREAMBLE_STEPS.length + ANSWER_STEPS.length);
    expect(timing.chars).toBe((PREAMBLE_STEPS[2] + ANSWER).length);
  });

  it("sets headers that forbid buffering and transformation of the stream", async () => {
    const res = await POST(streamRequest(), { params });
    // `no-transform` is what stops Next's gzip layer from re-chunking the body;
    // `X-Accel-Buffering: no` is what stops a proxy from holding it.
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-transform");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    await res.text();
  });
});
