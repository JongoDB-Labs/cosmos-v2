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
import { cosmosTools } from "@/lib/ai/tools";
import { executeTool } from "@/lib/ai/tool-executor";
import type { ParsedToolCall } from "@/lib/ai/tool-executor";
import { callClaudeCli, callClaudeCliStreaming } from "@/lib/ai/claude-cli";
import { sendMessage as sendPoolMessage } from "@/lib/ai/cli-pool";
import { buildMcpConfigForOrg, cleanupMcpConfig } from "@/lib/ai/mcp-config";

// `child_process.spawn` is not available on the Edge runtime — this route
// must run on Node. With cacheComponents enabled, route segment configs
// like `runtime` and `dynamic` are not supported (Node is default and
// pages are dynamic by default, so neither export is needed).

const sendMessageSchema = z.object({
  content: z.string().min(1),
  // Optional per-request model override (e.g. "sonnet" | "opus" | "haiku").
  // Falls back to the server-wide default (env COSMOS_AI_MODEL) when absent.
  model: z.string().min(1).max(64).optional(),
});

type RouteParams = {
  params: Promise<{ orgId: string; conversationId: string }>;
};

const BASE_SYSTEM_PROMPT =
  "You are COSMOS AI, an assistant for the COSMOS project management platform. You can query and modify project data using the tools available to you. Be concise and helpful. When asked about project status, use tools to get real data rather than guessing.";

const MAX_TOOL_ITERATIONS = 5;
const AI_MODEL_DEFAULT = process.env.COSMOS_AI_MODEL || "sonnet";
const ALLOWED_MODELS = new Set(["sonnet", "opus", "haiku"]);

/**
 * Persisted shape for `AssistantMessage.toolCalls`. We keep the okr-dashboard
 * field names (`name`, `arguments`, plus a synthetic `id` and the recorded
 * `result`) so any UI built off the existing data continues to parse.
 */
interface PersistedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

function renderHistoryForPrompt(
  messages: { role: string; content: string }[]
): string {
  // Render prior conversation as plain text. The CLI runs in `-p` one-shot
  // mode (no session persistence) — each call is independent, so we
  // serialize history into the user prompt rather than relying on the CLI's
  // own session machinery.
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

function renderToolResultsForFollowup(
  prior: string,
  results: { call: ParsedToolCall; output: unknown }[]
): string {
  const block = results
    .map(
      (r) =>
        `Tool ${r.call.name} returned: ${JSON.stringify(r.output)}`
    )
    .join("\n\n");
  return `${prior}\n\n[Tool results — use these to compose your reply. Issue more TOOL_CALL lines only if you genuinely need additional data.]\n${block}\n\nAssistant:`;
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
    // allowlist, otherwise fall back to the env-configured default. This
    // prevents the client from passing an arbitrary --model alias straight
    // to the CLI.
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

    const wantsStream = (request.headers.get("accept") ?? "").includes(
      "text/event-stream",
    );

    // Build a per-turn MCP config file (or `null` if the org has no enabled
    // servers). Lifetime ownership differs by code path:
    //   - pool mode: the pool owns the file once spawnPoolEntry baked it
    //     into the process; we just hand it off and let the pool delete it
    //     on process death. Mid-conversation new configs are discarded.
    //   - one-shot fallback: we delete it ourselves after the CLI exits.
    const mcpConfigPath = await buildMcpConfigForOrg(orgId);

    if (wantsStream) {
      return runStreaming({
        orgId,
        userId: ctx.userId,
        conversationId,
        transcriptHistory,
        ipAddress: getIpAddress(request),
        model,
        latestUserContent: data.content,
        cliSessionId: conversation.cliSessionId ?? null,
        mcpConfigPath,
      });
    }

    return runBlocking({
      orgId,
      userId: ctx.userId,
      conversationId,
      transcriptHistory,
      ipAddress: getIpAddress(request),
      model,
      latestUserContent: data.content,
      cliSessionId: conversation.cliSessionId ?? null,
      mcpConfigPath,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

interface IterationCtx {
  orgId: string;
  userId: string;
  conversationId: string;
  transcriptHistory: { role: string; content: string }[];
  ipAddress: string | undefined;
  model: string;
  /** Just the user's new message — what we hand the persistent CLI session. */
  latestUserContent: string;
  /** Stored CLI session id from `AssistantConversation.cliSessionId`, if any. */
  cliSessionId: string | null;
  /**
   * Path to a per-turn MCP config tempfile (or null when the org has none
   * enabled). Pool path: handed off to the pool, which owns deletion. Other
   * paths: this function deletes it before returning.
   */
  mcpConfigPath: string | null;
}

async function runBlocking(ctx: IterationCtx): Promise<Response> {
  let prompt = renderHistoryForPrompt(ctx.transcriptHistory);
  const persistedToolCalls: PersistedToolCall[] = [];
  let finalText = "";
  let iterations = 0;

  try {
    while (iterations < MAX_TOOL_ITERATIONS) {
      const reply = await callClaudeCli(
        BASE_SYSTEM_PROMPT,
        prompt,
        cosmosTools,
        {
          model: ctx.model,
          mcpConfigPath: ctx.mcpConfigPath ?? undefined,
        },
      );
      if (reply.toolCalls.length === 0) {
        finalText = reply.content;
        break;
      }
      const results: { call: ParsedToolCall; output: unknown }[] = [];
      for (const call of reply.toolCalls) {
        const output = await executeTool(call.name, call.arguments, {
          orgId: ctx.orgId,
          userId: ctx.userId,
        });
        results.push({ call, output });
        persistedToolCalls.push({
          id: `tc_${persistedToolCalls.length + 1}_${Date.now()}`,
          name: call.name,
          arguments: call.arguments,
          result: output,
        });
      }
      prompt = renderToolResultsForFollowup(
        `${prompt}\n\nAssistant: ${reply.content}`,
        results,
      );
      iterations++;
    }

    if (!finalText) {
      finalText =
        "I ran out of tool-call iterations before reaching a final answer. Please rephrase or narrow the request.";
    }

    const assistantMsg = await persistAssistantMessage(
      ctx,
      finalText,
      persistedToolCalls,
    );
    return created(assistantMsg);
  } finally {
    // One-shot path owns its temp file lifetime.
    await cleanupMcpConfig(ctx.mcpConfigPath);
  }
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

      const persistedToolCalls: PersistedToolCall[] = [];
      let finalText = "";
      let iterations = 0;

      // Phase 2: try the persistent CLI process pool first; on failure, fall
      // back to the one-shot path we shipped in Phase 1. The pool reuses one
      // long-lived `claude -p` subprocess per conversation (keyed by
      // AssistantConversation.cliSessionId) so follow-up messages skip the
      // ~2-3s cold start.
      let usePool = true;
      let poolSessionId: string | null = ctx.cliSessionId;
      let nextInput = ctx.latestUserContent;
      // The pool path hands ctx.mcpConfigPath off to the pool, which owns
      // deletion. The fallback path uses its own freshly built file because
      // the pool's failure handler may have already deleted the original.
      let fallbackMcpConfigPath: string | null = null;

      try {
        while (iterations < MAX_TOOL_ITERATIONS) {
          let iterationText = "";
          const onDelta = (delta: string) => {
            iterationText += delta;
            const safe = stripToolCallTail(delta, iterationText);
            if (safe) send({ type: "text", text: safe });
          };

          let reply: Awaited<ReturnType<typeof callClaudeCliStreaming>>;

          if (usePool) {
            try {
              const poolReply = await sendPoolMessage(
                ctx.conversationId,
                nextInput,
                BASE_SYSTEM_PROMPT,
                cosmosTools,
                onDelta,
                {
                  model: ctx.model,
                  existingSessionId: poolSessionId,
                  // Only meaningful on first spawn; the pool ignores (and
                  // cleans up) subsequent values within the same process.
                  mcpConfigPath: ctx.mcpConfigPath,
                },
              );
              reply = { content: poolReply.content, toolCalls: poolReply.toolCalls };
              poolSessionId = poolReply.sessionId;
            } catch (poolErr) {
              // First-iteration pool failure: degrade to legacy one-shot
              // streaming with the full transcript. Subsequent iterations
              // would have lost context anyway, so we also rebuild from
              // scratch when this happens.
              usePool = false;
              const fallbackPrompt =
                renderHistoryForPrompt(ctx.transcriptHistory);
              const transcriptPrompt =
                iterations === 0
                  ? fallbackPrompt
                  : `${fallbackPrompt}\n\nAssistant: ${finalText}\n\nUser: ${nextInput}`;
              // Log so operators can spot pool degradation in audit metadata.
              send({
                type: "debug",
                pool: "fallback",
                reason:
                  poolErr instanceof Error ? poolErr.message : String(poolErr),
              });
              iterationText = "";
              // The pool's finalize() may have already cleaned up the temp
              // MCP config file on its way down — rebuild for the fallback
              // path so the one-shot CLI still gets the org's MCP servers.
              if (ctx.mcpConfigPath) {
                fallbackMcpConfigPath = await buildMcpConfigForOrg(ctx.orgId);
              }
              reply = await callClaudeCliStreaming(
                BASE_SYSTEM_PROMPT,
                transcriptPrompt,
                cosmosTools,
                {
                  model: ctx.model,
                  onTextDelta: onDelta,
                  mcpConfigPath: fallbackMcpConfigPath ?? undefined,
                },
              );
            }
          } else {
            // Legacy path — full transcript rebuilt each iteration.
            const fallbackPrompt = renderHistoryForPrompt(ctx.transcriptHistory);
            const transcriptPrompt =
              iterations === 0
                ? fallbackPrompt
                : `${fallbackPrompt}\n\nAssistant: ${finalText}\n\n${nextInput}`;
            reply = await callClaudeCliStreaming(
              BASE_SYSTEM_PROMPT,
              transcriptPrompt,
              cosmosTools,
              {
                model: ctx.model,
                onTextDelta: onDelta,
                mcpConfigPath: fallbackMcpConfigPath ?? undefined,
              },
            );
          }

          if (reply.toolCalls.length === 0) {
            finalText += (finalText ? "\n\n" : "") + reply.content;
            break;
          }

          // Flush the prose portion we haven't already sent.
          finalText += (finalText ? "\n\n" : "") + reply.content;

          const iterationToolResults: { call: ParsedToolCall; output: unknown }[] =
            [];
          for (const call of reply.toolCalls) {
            send({
              type: "tool_call_start",
              id: `tc_${persistedToolCalls.length + 1}_${Date.now()}`,
              name: call.name,
              arguments: call.arguments,
            });
            const output = await executeTool(call.name, call.arguments, {
              orgId: ctx.orgId,
              userId: ctx.userId,
            });
            const tc: PersistedToolCall = {
              id: `tc_${persistedToolCalls.length + 1}_${Date.now()}`,
              name: call.name,
              arguments: call.arguments,
              result: output,
            };
            persistedToolCalls.push(tc);
            iterationToolResults.push({ call, output });
            send({ type: "tool_call_result", id: tc.id, result: output });
          }

          // The next CLI turn carries the tool results back to the model.
          // Pool mode: send only the new tool-results block — the session
          // already has prior turns. Fallback mode: the loop above will
          // rebuild from the full transcript using `nextInput`.
          const followup = renderToolResultsForFollowup("", iterationToolResults);
          nextInput = followup.trim();
          iterations++;
        }

        if (!finalText) {
          finalText =
            "I ran out of tool-call iterations before reaching a final answer. Please rephrase or narrow the request.";
          send({ type: "text", text: finalText });
        }

        const assistantMsg = await persistAssistantMessage(
          ctx,
          finalText,
          persistedToolCalls,
          { cliSessionId: poolSessionId },
        );
        send({
          type: "done",
          messageId: assistantMsg.id,
          content: finalText,
          toolCalls: persistedToolCalls,
        });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        // Fallback-path tempfile is ours to clean. The pool-path tempfile
        // (ctx.mcpConfigPath) is owned by the pool when the pool was used;
        // when the pool failed, its finalize() already cleaned it up.
        await cleanupMcpConfig(fallbackMcpConfigPath);
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

/**
 * The model may stream `TOOL_CALL: {...}` lines mid-response. The user
 * doesn't want to see those raw markers, so once a delta crosses into a
 * TOOL_CALL line, stop emitting further text deltas for this iteration.
 * Returns the portion of `delta` we should still forward (or empty string).
 */
function stripToolCallTail(delta: string, accumulated: string): string {
  const accBeforeDelta = accumulated.slice(0, accumulated.length - delta.length);
  // If a TOOL_CALL marker already started before this delta, suppress.
  if (/TOOL_CALL\s*:/.test(accBeforeDelta)) return "";
  // If the marker starts within this delta, only forward the part before it.
  const idx = accumulated.search(/TOOL_CALL\s*:/);
  if (idx === -1) return delta;
  const cutoff = idx - accBeforeDelta.length;
  return cutoff > 0 ? delta.slice(0, cutoff) : "";
}

async function persistAssistantMessage(
  ctx: IterationCtx,
  text: string,
  toolCalls: PersistedToolCall[],
  opts: { cliSessionId?: string | null } = {},
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

  // Only PATCH the conversation row's session id when the pool actually
  // produced one and it differs from what we already stored. Avoids spurious
  // writes on the blocking path (which never touches the pool).
  const conversationPatch: Prisma.AssistantConversationUpdateInput = {
    updatedAt: new Date(),
  };
  if (
    typeof opts.cliSessionId === "string" &&
    opts.cliSessionId &&
    opts.cliSessionId !== ctx.cliSessionId
  ) {
    conversationPatch.cliSessionId = opts.cliSessionId;
  }
  await prisma.assistantConversation.update({
    where: { id: ctx.conversationId },
    data: conversationPatch,
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
      backend: "claude-cli",
      pool: opts.cliSessionId ? "persistent" : "one-shot",
    } as unknown as Prisma.InputJsonValue,
    ipAddress: ctx.ipAddress,
  });
  return assistantMsg;
}
