import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { purposeKey } from "@/lib/crypto/vault";
import { bulkTargetIds } from "./executors/bulk";
import type { ToolContext } from "./executors/_ctx";
import { CONFIRMATION_TOKEN_ARG } from "./confirm-class";
import type { ToolDefinition } from "./tools";

/**
 * The confirmation step for confirm-class tools (see confirm-class.ts), enforced
 * in the agent loop rather than asked of the model.
 *
 *   1. A call WITHOUT a token changes nothing. It resolves the targets the call
 *      would act on, stores a preview row, and returns the preview (the change,
 *      the target ids) with a token.
 *   2. The token is `cf1.<kid>.<nonce>.<mac>`: an HMAC, under a key derived from
 *      the vault key, over the nonce, the user, org, conversation, tool, a hash of
 *      the arguments, a hash of the resolved ids, the expiry and the newest USER
 *      message at the time of the preview.
 *   3. A call WITH the token commits only when the MAC verifies, it is unexpired
 *      (five minutes) and unused, the arguments are the ones previewed, the run
 *      was started by a USER message newer than the preview, and the targets,
 *      resolved again now, are the same ids. The row is then marked used by a
 *      conditional update, so the token is single-use across instances.
 *
 * Step 3's "newer USER message" is what makes the user, not the model, the one
 * who says yes: the run that issued a preview can never spend it, whatever the
 * model or the data it read says.
 *
 * The chat history the model sees is text only, so a later run would not have
 * the token. The loop puts the conversation's waiting previews, with their
 * tokens, into the next run's system prompt (`pendingConfirmationsBlock`).
 *
 * A run with no assistant conversation of this user's (a chat bot, a meeting
 * summary) has no way to ask, so the loop does not offer these tools at all.
 */

export const CONFIRMATION_TTL_MS = 5 * 60_000;
/** Previews this long past expiry are deleted when the conversation issues a new one. */
const CLEANUP_AFTER_MS = 60 * 60_000;
const TOKEN_VERSION = "cf1";
const KEY_PURPOSE = "assistant-confirmation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run's way to ask its user: their own assistant conversation, and the USER message that started this run. */
export interface ConfirmationChannel {
  conversationId: string;
  runMessage: { id: string; createdAt: Date };
}

async function latestUserMessage(conversationId: string) {
  return prisma.assistantMessage.findFirst({
    where: { conversationId, role: "USER" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true },
  });
}

/**
 * This run's confirmation channel, or null when it has none: the conversation id
 * is not an assistant conversation that belongs to this user in this org, or it
 * has no user message. Read once, when the run starts. Fails closed.
 */
export async function confirmationChannel(a: { orgId: string; userId: string; conversationId: string }): Promise<ConfirmationChannel | null> {
  if (!UUID.test(a.conversationId)) return null;
  try {
    const conversation = await prisma.assistantConversation.findFirst({
      where: { id: a.conversationId, orgId: a.orgId, userId: a.userId },
      select: { id: true },
    });
    if (!conversation) return null;
    const runMessage = await latestUserMessage(a.conversationId);
    return runMessage ? { conversationId: a.conversationId, runMessage } : null;
  } catch {
    return null;
  }
}

/** The tool as the model is offered it: with the optional token argument described. */
export function withConfirmationArg(def: ToolDefinition): ToolDefinition {
  const schema = def.input_schema as { properties?: Record<string, unknown> };
  return {
    ...def,
    input_schema: {
      ...def.input_schema,
      properties: {
        ...(schema.properties ?? {}),
        [CONFIRMATION_TOKEN_ARG]: {
          type: "string",
          description:
            "Leave this out at first: the call then changes nothing and returns a preview and a token. " +
            "Show the user the preview and ask them to confirm. Only after they say yes, call again with exactly the same arguments plus this token.",
        },
      },
    },
  };
}

export function withoutToken(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest[CONFIRMATION_TOKEN_ARG];
  return rest;
}

/** JSON with object keys sorted, so equal arguments hash equal however the model ordered them. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * The ids a call would act on. A bulk change resolves its selection exactly as
 * its executor does; any other confirm-class tool acts on the ids it names.
 * `refusal` is the executor's own answer for an input it would refuse.
 */
async function resolveTargets(
  toolName: string,
  execArgs: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ids: string[] } | { refusal: Record<string, unknown> }> {
  if (toolName === "bulk_update_work_items") return bulkTargetIds(execArgs, ctx);
  const ids = new Set<string>();
  for (const [k, v] of Object.entries(execArgs)) {
    if (/(^id|Id)$/.test(k) && typeof v === "string") ids.add(v);
    if (/(^ids|Ids)$/.test(k) && Array.isArray(v)) for (const x of v) if (typeof x === "string") ids.add(x);
  }
  return { ids: [...ids].sort() };
}

interface MacFields {
  nonce: string;
  kid: string;
  orgId: string;
  userId: string;
  conversationId: string;
  toolName: string;
  argsHash: string;
  idsHash: string;
  expiresAt: number;
  afterMessageId: string;
}

function mac(key: Buffer, f: MacFields): string {
  return crypto
    .createHmac("sha256", key)
    .update([TOKEN_VERSION, f.nonce, f.kid, f.orgId, f.userId, f.conversationId, f.toolName, f.argsHash, f.idsHash, String(f.expiresAt), f.afterMessageId].join("\n"))
    .digest("base64url");
}

function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export interface GateInput {
  channel: ConfirmationChannel;
  orgId: string;
  userId: string;
  toolName: string;
  /** The arguments as the model sent them (handles unresolved). */
  args: Record<string, unknown>;
  /** The arguments the executor would receive (handles resolved, policy applied). */
  execInput: Record<string, unknown>;
  ctx: ToolContext;
}

/**
 * What the loop does with a confirm-class call:
 *  - `notice`  : don't run it; hand the model this preview or refusal (written
 *                here, no row content: the model's own arguments, ids, counts).
 *                `forUser` is what the conversation's tool trail keeps.
 *  - `result`  : don't run it; this is the executor's own refusal of the input,
 *                to go through the egress gate like any tool result.
 *  - `proceed` : the user confirmed; run it with `execInput` (token removed).
 */
export type GateDecision =
  | { kind: "notice"; forModel: Record<string, unknown>; forUser: Record<string, unknown> }
  | { kind: "result"; output: Record<string, unknown> }
  | { kind: "proceed"; execInput: Record<string, unknown> };

export async function confirmationGate(g: GateInput): Promise<GateDecision> {
  const token = g.args[CONFIRMATION_TOKEN_ARG];
  const args = withoutToken(g.args);
  const execArgs = withoutToken(g.execInput);
  if (token === undefined || token === null || token === "") return issuePreview(g, args, execArgs);
  return redeem(g, token, args, execArgs);
}

const notice = (forModel: Record<string, unknown>): GateDecision => ({ kind: "notice", forModel, forUser: forModel });

async function issuePreview(g: GateInput, args: Record<string, unknown>, execArgs: Record<string, unknown>): Promise<GateDecision> {
  const targets = await resolveTargets(g.toolName, execArgs, g.ctx);
  if ("refusal" in targets) return { kind: "result", output: targets.refusal };
  if (targets.ids.length === 0) {
    return { kind: "result", output: { matched: 0, updated: 0, items: [], skipped: [], note: "Nothing matches that selection, so nothing was changed." } };
  }
  let derived: { kid: string; key: Buffer };
  try {
    derived = purposeKey(KEY_PURPOSE);
  } catch {
    return notice({
      error: "This server has no vault key, so it can't ask the user to confirm, and this change can't be made from chat. Tell the user to make it in the app.",
    });
  }
  // The newest user message NOW: only one after it can confirm this preview.
  const after = await latestUserMessage(g.channel.conversationId);
  if (!after) return notice({ error: "There is no user message to confirm against. Ask the user what they want." });

  const nonce = crypto.randomUUID();
  const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
  const fields: MacFields = {
    nonce,
    kid: derived.kid,
    orgId: g.orgId,
    userId: g.userId,
    conversationId: g.channel.conversationId,
    toolName: g.toolName,
    argsHash: sha256(canonical(args)),
    idsHash: sha256(canonical(targets.ids)),
    expiresAt,
    afterMessageId: after.id,
  };
  await prisma.assistantConfirmation.create({
    data: {
      id: nonce,
      orgId: g.orgId,
      userId: g.userId,
      conversationId: g.channel.conversationId,
      toolName: g.toolName,
      args: args as Prisma.InputJsonValue,
      argsHash: fields.argsHash,
      idsHash: fields.idsHash,
      targetCount: targets.ids.length,
      afterMessageId: after.id,
      kid: derived.kid,
      expiresAt: new Date(expiresAt),
    },
  });
  await prisma.assistantConfirmation
    .deleteMany({ where: { conversationId: g.channel.conversationId, expiresAt: { lt: new Date(Date.now() - CLEANUP_AFTER_MS) } } })
    .catch(() => undefined);

  const preview = {
    status: "confirmation_required",
    tool: g.toolName,
    change: args,
    targetCount: targets.ids.length,
    targetIds: targets.ids,
    expiresAt: new Date(expiresAt).toISOString(),
    instruction:
      "Nothing has changed yet. Tell the user exactly what this will do (how many items, and what changes on them) and ask them to confirm. " +
      `Stop there. Only if their next message says yes, call ${g.toolName} again with exactly the same arguments plus confirmationToken.`,
  };
  return {
    kind: "notice",
    forModel: { ...preview, confirmationToken: `${TOKEN_VERSION}.${derived.kid}.${nonce}.${mac(derived.key, fields)}` },
    forUser: preview,
  };
}

const INVALID = {
  error:
    "That confirmation token is not valid for this call. Call the tool again without a token to get a fresh preview, and ask the user to confirm it.",
};

async function redeem(g: GateInput, token: unknown, args: Record<string, unknown>, execArgs: Record<string, unknown>): Promise<GateDecision> {
  if (typeof token !== "string") return notice(INVALID);
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION || !UUID.test(parts[2])) return notice(INVALID);
  const [, kid, nonce, given] = parts;

  const row = await prisma.assistantConfirmation.findUnique({ where: { id: nonce } });
  if (
    !row ||
    row.kid !== kid ||
    row.orgId !== g.orgId ||
    row.userId !== g.userId ||
    row.conversationId !== g.channel.conversationId ||
    row.toolName !== g.toolName
  ) {
    return notice(INVALID);
  }
  let key: Buffer;
  try {
    key = purposeKey(KEY_PURPOSE, kid).key;
  } catch {
    return notice(INVALID);
  }
  const expected = mac(key, {
    nonce: row.id,
    kid: row.kid,
    orgId: row.orgId,
    userId: row.userId,
    conversationId: row.conversationId,
    toolName: row.toolName,
    argsHash: row.argsHash,
    idsHash: row.idsHash,
    expiresAt: row.expiresAt.getTime(),
    afterMessageId: row.afterMessageId,
  });
  if (!sameMac(given, expected)) return notice(INVALID);

  if (row.usedAt) {
    return notice({ error: "That confirmation has already been used. For another change, call the tool again without a token and ask the user again." });
  }
  if (Date.now() > row.expiresAt.getTime()) {
    return notice({
      error: "That confirmation has expired (they last five minutes). Call the tool again without a token for a fresh preview, and ask the user again.",
    });
  }
  if (sha256(canonical(args)) !== row.argsHash) {
    return notice({
      error:
        "This call differs from the change the user was shown, so it was not made. Call the tool again without a token for a preview of this change, and ask the user to confirm it.",
    });
  }
  // The user, not the model, says yes: this run must have been started by a
  // USER message newer than the one the preview was issued after.
  const after = await prisma.assistantMessage.findUnique({ where: { id: row.afterMessageId }, select: { createdAt: true } });
  if (!after || g.channel.runMessage.id === row.afterMessageId || g.channel.runMessage.createdAt.getTime() <= after.createdAt.getTime()) {
    return notice({
      error: "The user has not answered the preview yet. Show it to them, ask them to confirm, and wait for their reply. Nothing was changed.",
    });
  }
  const targets = await resolveTargets(g.toolName, execArgs, g.ctx);
  if ("refusal" in targets) return { kind: "result", output: targets.refusal };
  if (sha256(canonical(targets.ids)) !== row.idsHash) {
    return notice({
      error:
        `The selection has changed since the user was shown it: it now matches ${targets.ids.length} item${targets.ids.length === 1 ? "" : "s"}, not ${row.targetCount}. ` +
        "Nothing was changed. Call the tool again without a token for a fresh preview, and ask the user again.",
    });
  }
  const claimed = await prisma.assistantConfirmation.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) {
    return notice({ error: "That confirmation has already been used. For another change, call the tool again without a token and ask the user again." });
  }
  return { kind: "proceed", execInput: execArgs };
}

/**
 * The conversation's previews still waiting for the user, for the next run's
 * system prompt: the history the model sees is text only, so without this the
 * token would be gone by the time the user answers. Only previews issued before
 * the message that started this run are listed (the user has seen them).
 */
export async function pendingConfirmationsBlock(a: { channel: ConfirmationChannel; orgId: string; userId: string }): Promise<string | null> {
  const rows = await prisma.assistantConfirmation.findMany({
    where: {
      conversationId: a.channel.conversationId,
      orgId: a.orgId,
      userId: a.userId,
      usedAt: null,
      expiresAt: { gt: new Date(Date.now()) },
      afterMessageId: { not: a.channel.runMessage.id },
    },
    orderBy: { createdAt: "asc" },
    take: 10,
  });
  const lines: string[] = [];
  for (const row of rows) {
    let key: Buffer;
    try {
      key = purposeKey(KEY_PURPOSE, row.kid).key;
    } catch {
      continue;
    }
    const token = `${TOKEN_VERSION}.${row.kid}.${row.id}.${mac(key, {
      nonce: row.id,
      kid: row.kid,
      orgId: row.orgId,
      userId: row.userId,
      conversationId: row.conversationId,
      toolName: row.toolName,
      argsHash: row.argsHash,
      idsHash: row.idsHash,
      expiresAt: row.expiresAt.getTime(),
      afterMessageId: row.afterMessageId,
    })}`;
    lines.push(
      `- ${row.toolName} (${row.targetCount} target${row.targetCount === 1 ? "" : "s"}), expires ${row.expiresAt.toISOString()}. ` +
        `Arguments: ${JSON.stringify(row.args)}. confirmationToken: ${token}`,
    );
  }
  if (lines.length === 0) return null;
  return [
    "## Changes waiting for the user's confirmation",
    "You showed the user a preview of each change below and asked them to confirm. If the user's latest message clearly says yes to one, call that tool with exactly the arguments shown plus its confirmationToken. If they said no, asked for something different, or did not answer, do not call it; a different change needs a new preview.",
    ...lines,
  ].join("\n");
}
