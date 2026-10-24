/**
 * "Ask AI to build a filter" (query design §12.3): a sentence in, CQL text out,
 * for the editor to show. It never runs the query.
 *
 * The model gets the language reference (the registries and this org's custom
 * field names: schema, never data) and the user's sentence, through the egress
 * chokepoint like every model call. It answers with one query; when that query
 * has errors, it gets the diagnostics once to correct itself, and whatever
 * comes back is returned with its diagnostics either way. The user decides.
 */
import { prisma } from "@/lib/db/client";
import { runModelTurn, type ModelMessage } from "@/lib/ai/egress";
import type { AuthContext } from "@/lib/rbac/check";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { prepareCql } from "./execute.server";
import { loadSchemaCustomFields } from "./resolve.server";
import { cqlFromReply, cqlReference } from "./describe";
import { CqlError, type CqlDiagnostic } from "./errors";
import { CQL_LIMITS } from "./ast";

export const AI_PROMPT_MAX = 500;

/** The model couldn't be reached or refused the turn (no credential, provider down, a marking). */
export class AiUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The assistant is unavailable", { cause });
    this.name = "AiUnavailableError";
  }
}
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

function system(reference: string): string {
  return [
    "You turn a request for a list of work items into one CQL query.",
    "Reply with ONLY the query on one line: no explanation, no code fence.",
    "Use `me` for the person asking. Use the field and value spellings below; put values with spaces in double quotes.",
    "If the request can't be expressed, reply with the closest query you can.",
    "",
    reference,
  ].join("\n");
}

async function check(ctx: AuthContext, cql: string, tz?: string): Promise<CqlDiagnostic[]> {
  try {
    return (await prepareCql(ctx, { cql }, { mode: "warn", tz })).diagnostics;
  } catch (e) {
    if (e instanceof CqlError) return e.diagnostics;
    throw e;
  }
}

const describeErrors = (ds: CqlDiagnostic[]) =>
  ds.filter((d) => d.severity === "error").map((d) => `col ${d.column}: ${d.message}${d.hint ? ` (${d.hint})` : ""}`).join("\n");

export async function cqlFromText(
  ctx: AuthContext,
  prompt: string,
  opts: { tz?: string } = {},
): Promise<{ cql: string; diagnostics: CqlDiagnostic[] }> {
  const org = await prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { tenantClass: true } });
  const tenantClass = org?.tenantClass === "COMMERCIAL" ? "commercial" : "gov";
  const customFields = await loadSchemaCustomFields(ctx.orgId, await getReadableProjectIds(ctx));
  const sys = system(cqlReference(customFields));
  const egress = { orgId: ctx.orgId, userId: ctx.userId, conversationId: `cql-ai-${ctx.userId}`, tenantClass, mode: "enforced" } as const;

  const messages: ModelMessage[] = [{ role: "user", content: prompt }];
  let cql = "";
  let diagnostics: CqlDiagnostic[] = [];
  for (let turn = 0; turn < 2; turn++) {
    const reply = await runModelTurn({ ctx: { ...egress, turn }, system: sys, messages, tools: [], model: MODEL, maxTokens: 400 }).catch((e) => {
      throw new AiUnavailableError(e);
    });
    cql = cqlFromReply(reply.text).slice(0, CQL_LIMITS.textLength);
    diagnostics = cql ? await check(ctx, cql, opts.tz) : [];
    if (!diagnostics.some((d) => d.severity === "error")) break;
    messages.push(
      { role: "assistant", content: reply.text },
      { role: "user", content: `That query has errors:\n${describeErrors(diagnostics)}\nReply with the corrected query only.` },
    );
  }
  return { cql, diagnostics };
}
