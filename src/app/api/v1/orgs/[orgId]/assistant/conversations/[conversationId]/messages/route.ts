import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import {
  success,
  created,
  handleApiError,
  getIpAddress,
} from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { runAgentLoop, type AgentToolCall } from "@/lib/ai/agent-loop";

const sendMessageSchema = z.object({
  content: z.string().min(1),
  // Optional per-request model override (e.g. "sonnet" | "opus" | "haiku").
  // Falls back to the server-wide default (env COSMOS_AI_MODEL) when absent.
  model: z.string().min(1).max(64).optional(),
});

type RouteParams = {
  params: Promise<{ orgId: string; conversationId: string }>;
};

/** Cosmo's identity + operating guidance. Capability DETAILS deliberately defer
 *  to the live tool list (it varies per org policy/tenant class and grows with
 *  the product) so this prompt can't fossilize the way its predecessor did —
 *  never enumerate a hardcoded feature menu here. */
const BASE_SYSTEM_PROMPT = `You are Cosmo — the agentic AI assistant built into COSMOS, the project management platform. Introduce yourself as Cosmo.

What you do: you don't just answer — you take actions in the workspace through your tools: querying and creating/updating work items, sprints and program increments, OKRs, risks and the other PM registers, feedback, projects, finance, compliance, CRM, meetings, notes, documents, and the org's connected integrations. Your CURRENT tool list is authoritative for what you can do right now (it varies by organization policy) — when asked what you can help with, summarize from the tools you actually have, grouped simply; never recite a fixed menu.

Platform context you should know:
- Tickets use refs like COSMOS-12; write them that way in prose.
- Users can @-mention people and any entity (tickets, docs, objectives…) in chat and comments; entity tokens look like <@workItem:UUID> — resolve and use their ids when present in a message.
- Foreman is the org's autonomous delivery agent: it builds and ships backlog tickets, parks risky changes as draft PRs, and can be steered by owners/admins @-mentioning @Foreman on a ticket. You are Cosmo (conversation + in-app actions); Foreman is delivery. Route "build/ship this ticket" wishes toward Foreman mentions; handle everything else yourself.
- Voice: users can wake you with "Hey Cosmo" and dictate messages, ending with their send phrase (default "send it").

Operating rules:
- Use tools for real data; never guess counts, statuses, or contents.
- Prefer acting over describing: if the user asks for something a tool can do, do it, then report what changed (with refs/ids).
- Confirm before destructive or hard-to-reverse operations (deletes, completions, bulk changes) unless the user already stated exactly what to do.
- Be concise. Plain prose, short lists when helpful; no emoji walls.`;

const AI_MODEL_DEFAULT = process.env.COSMOS_AI_MODEL || "sonnet";
const ALLOWED_MODELS = new Set(["sonnet", "opus", "haiku"]);

/**
 * Persisted shape for `AssistantMessage.toolCalls`. We keep the okr-dashboard
 * field names (`name`, `arguments`, plus a synthetic `id` and the recorded
 * `result`) so any UI built off the existing data continues to parse. The
 * unified agent loop returns `AgentToolCall` in exactly this shape.
 */
type PersistedToolCall = AgentToolCall;

function renderHistoryForPrompt(
  messages: { role: string; content: string }[]
): string {
  // Render prior conversation as plain text. The model call is stateless
  // (runModelTurn is one request/response per turn, no session persistence) —
  // each request is independent, so we serialize the transcript into the
  // initial user prompt rather than relying on any upstream session.
  return messages
    .map((m) => {
      const tag =
        m.role === "USER" || m.role === "user"
          ? "User"
          : m.role === "ASSISTANT" || m.role === "assistant"
          ? "Assistant"
          : m.role;
      return `${tag}: ${m.content}`;
    })
    .join("\n\n");
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, conversationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CHAT_USE);

    const conversation = await prisma.assistantConversation.findFirst({
      where: { id: conversationId, orgId, userId: ctx.userId },
    });
    if (!conversation) return new Response("Not found", { status: 404 });

    const limit = Math.min(
      parseInt(request.nextUrl.searchParams.get("limit") ?? "50", 10),
      200
    );

    const messages = await prisma.assistantMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    return success(messages);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, conversationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CHAT_USE);

    const limited = checkRateLimit(request, "chat.message", ctx.userId, {
      capacity: 20,
      refillPerSecond: 0.5,
    });
    if (limited) return limited;

    const conversation = await prisma.assistantConversation.findFirst({
      where: { id: conversationId, orgId, userId: ctx.userId },
    });
    if (!conversation) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = sendMessageSchema.parse(body);

    // Resolve the model: honor the per-request value when it's in our
    // allowlist, otherwise fall back to the env-configured default.
    const model =
      data.model && ALLOWED_MODELS.has(data.model)
        ? data.model
        : AI_MODEL_DEFAULT;

    await prisma.assistantMessage.create({
      data: {
        conversationId,
        role: "USER",
        content: data.content,
      },
    });

    const history = await prisma.assistantMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      take: 50,
    });

    const transcriptHistory = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    // The latest user message is already persisted above, so it's included in
    // the transcript. Serialize the whole thing into the loop's initial prompt.
    const initialPrompt = renderHistoryForPrompt(transcriptHistory);

    const wantsStream = (request.headers.get("accept") ?? "").includes(
      "text/event-stream",
    );

    const iterationCtx: IterationCtx = {
      orgId,
      userId: ctx.userId,
      conversationId,
      initialPrompt,
      ipAddress: getIpAddress(request),
      model,
      // fail-closed: only an explicit COMMERCIAL org gets the permissive class.
      tenantClass: org.tenantClass === "COMMERCIAL" ? "commercial" : "gov",
    };

    if (wantsStream) {
      return runStreaming(iterationCtx);
    }

    return runBlocking(iterationCtx);
  } catch (error) {
    return handleApiError(error);
  }
}

interface IterationCtx {
  orgId: string;
  userId: string;
  conversationId: string;
  /** The full transcript serialized into the loop's initial user prompt. */
  initialPrompt: string;
  ipAddress: string | undefined;
  model: string;
  /** The org's data-sensitivity class, mapped from Organization.tenantClass. */
  tenantClass: "gov" | "commercial";
}

async function runBlocking(ctx: IterationCtx): Promise<Response> {
  const result = await runAgentLoop({
    orgId: ctx.orgId,
    userId: ctx.userId,
    tenantClass: ctx.tenantClass,
    conversationId: ctx.conversationId,
    systemPrompt: BASE_SYSTEM_PROMPT,
    initialPrompt: ctx.initialPrompt,
    model: ctx.model,
  });

  const assistantMsg = await persistAssistantMessage(
    ctx,
    result.text,
    result.toolCalls,
  );
  return created(assistantMsg);
}

function runStreaming(ctx: IterationCtx): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(event: Record<string, unknown>) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* connection closed */
        }
      }

      try {
        // The unified loop streams the final answer's text via `onDelta`
        // (cumulative text-so-far); forward each update as a `text` SSE event.
        // Tool calls are surfaced after the run as `tool_call_*` events so the
        // existing client event contract (text / tool_call_start /
        // tool_call_result / done / error) is preserved.
        let lastSent = "";
        const result = await runAgentLoop({
          orgId: ctx.orgId,
          userId: ctx.userId,
          tenantClass: ctx.tenantClass,
          conversationId: ctx.conversationId,
          systemPrompt: BASE_SYSTEM_PROMPT,
          initialPrompt: ctx.initialPrompt,
          model: ctx.model,
          onDelta: (textSoFar) => {
            // onDelta carries the cumulative text for the current (final) turn.
            // Emit only the newly-appended slice so the client appends, not
            // re-renders, matching the previous per-delta `text` events.
            if (textSoFar.length <= lastSent.length) return;
            const delta = textSoFar.slice(lastSent.length);
            lastSent = textSoFar;
            if (delta) send({ type: "text", text: delta });
          },
        });

        // Surface tool calls (the loop returns them once the run completes).
        for (const tc of result.toolCalls) {
          send({
            type: "tool_call_start",
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
          send({ type: "tool_call_result", id: tc.id, result: tc.result });
        }

        // If the final answer never streamed any text (e.g. a tool-only run),
        // emit it once so the client has the full content before `done`.
        if (result.text && result.text !== lastSent) {
          send({ type: "text", text: result.text.slice(lastSent.length) || result.text });
        }

        const assistantMsg = await persistAssistantMessage(
          ctx,
          result.text,
          result.toolCalls,
        );
        send({
          type: "done",
          messageId: assistantMsg.id,
          content: result.text,
          toolCalls: result.toolCalls,
        });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function persistAssistantMessage(
  ctx: IterationCtx,
  text: string,
  toolCalls: PersistedToolCall[],
) {
  const toolCallsJson = toolCalls as unknown as Prisma.InputJsonValue;
  const assistantMsg = await prisma.assistantMessage.create({
    data: {
      conversationId: ctx.conversationId,
      role: "ASSISTANT",
      content: text,
      toolCalls: toolCallsJson,
    },
  });

  // Bump the conversation's updatedAt so it sorts to the top. The unified loop
  // is stateless (no upstream session), so AssistantConversation.cliSessionId
  // is no longer read or written — Phase 0 leaves the column unused.
  await prisma.assistantConversation.update({
    where: { id: ctx.conversationId },
    data: { updatedAt: new Date() },
  });

  await logAudit({
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "chat.message.sent",
    entity: "assistantMessage",
    entityId: assistantMsg.id,
    metadata: {
      conversationId: ctx.conversationId,
      toolCallCount: toolCalls.length,
      backend: "anthropic-sdk",
    } as unknown as Prisma.InputJsonValue,
    ipAddress: ctx.ipAddress,
  });
  return assistantMsg;
}
