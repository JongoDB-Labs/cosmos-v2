/**
 * The @answerer auto-respond predicate.
 *
 * The answerer bot can be wired to a channel with `ChatBotChannel.autoRespond`
 * so it answers ordinary questions WITHOUT an explicit @mention. That makes it
 * the one bot trigger that fires on a message nobody addressed to a bot, so it
 * needs a tight guard against the two failure modes:
 *
 *  1. DOUBLE-TRIGGER — a message that ALSO @mentions a bot already enqueues a
 *     mention-driven run in the messages route. Auto-respond must NOT fire for
 *     that same message or the channel gets two bot replies. The route only
 *     calls this AFTER it has decided NOT to run a mention (`mentionBot` is the
 *     resolved mention, or null); we hard-skip when one is present.
 *  2. BOT-LOOP — the answerer must never respond to a bot/assistant/system
 *     message (its own replies, the note-taker's, a system notice). Only a
 *     genuine human USER message in the main feed should ever trigger it.
 *
 * This is a PURE function (no DB/IO) so it is unit-tested in isolation; the
 * route layer supplies the booleans (rate-limit budget, channel wiring) it
 * can't know here.
 */

export interface AutoRespondInput {
  /** The posted message's kind. Only a human USER message may auto-trigger. */
  messageKind: "USER" | "ACTION" | "SYSTEM" | "ASSISTANT";
  /** True if the message is a thread reply (parentMessageId set). */
  isThreadReply: boolean;
  /** True if the message body is a slash command (handled elsewhere). */
  isSlashCommand: boolean;
  /** True if the author is a synthetic bot user (`User.isBot`). */
  authorIsBot: boolean;
  /** True if the poster holds CHAT_USE. */
  posterHasChatUse: boolean;
  /**
   * The bot a mention/`<@uuid>` in this message resolved to, or null. When set,
   * the route already enqueued a mention-driven run — auto-respond MUST stand
   * down to avoid a double reply.
   */
  mentionBot: string | null;
  /** Whether the answerer has an enabled, auto-respond ChatBotChannel row here. */
  answererAutoRespondEnabled: boolean;
}

/**
 * Decide whether the @answerer should auto-respond to a freshly-posted message.
 * Returns true ONLY when every guard passes. The caller still rate-limits and
 * runs the answerer detached; a `false` here means "do not even consider it".
 */
export function shouldAnswererAutoRespond(input: AutoRespondInput): boolean {
  // The channel must actually have the answerer wired for auto-respond.
  if (!input.answererAutoRespondEnabled) return false;
  // Never on a non-human message (own reply, note-taker, system notice).
  if (input.messageKind !== "USER") return false;
  if (input.authorIsBot) return false;
  // Thread replies and slash commands are out of scope for ambient answering.
  if (input.isThreadReply) return false;
  if (input.isSlashCommand) return false;
  // The poster must be allowed to use chat AI.
  if (!input.posterHasChatUse) return false;
  // DOUBLE-TRIGGER guard: a mention already enqueued a run for this message.
  if (input.mentionBot !== null) return false;
  return true;
}

/** A message is a slash command if its trimmed body starts with "/". */
export function isSlashCommand(content: string): boolean {
  return content.trimStart().startsWith("/");
}
