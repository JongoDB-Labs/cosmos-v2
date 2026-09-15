import { mentionsToPlainText, userMentionLabels } from "@/lib/mentions/plain-text";

type ContextMessage = { authorId: string; content: string; createdAt: Date };

export interface AiContextOptions {
  /** Channel display name, rendered as a preamble line so the bot knows where it is. */
  channelName?: string | null;
  /** Channel topic/description, rendered as a preamble line. */
  channelTopic?: string | null;
}

/** Resolve mention tokens to "@DisplayName" using the name map.
 *  Falls back to "@someone" for ids we couldn't resolve — never leaks a raw
 *  uuid into the prompt. (The old behaviour stripped every mention to a generic
 *  "@user", losing who was actually addressed.)
 *
 *  Delegates to the shared resolver so this prompt and every notification body
 *  agree, and so TYPED tokens (`<@workItem:…>`) resolve here too — the local
 *  regex only ever matched the legacy 36-character people form, leaving a raw
 *  id in the prompt for anything else. */
function resolveMentions(text: string, namesById: Map<string, string>): string {
  return mentionsToPlainText(
    text,
    userMentionLabels([...namesById].map(([id, displayName]) => ({ id, displayName }))),
  );
}

/** Format recent channel messages as "Name: text" lines for an AI bot prompt.
 *  Optionally prepends a channel preamble (name + topic) and resolves `<@uuid>`
 *  mentions to real display names so the bot understands the context and who
 *  is who. Backwards compatible: called with just (messages, namesById) it
 *  behaves like before, except mentions now resolve to names instead of "@user". */
export function formatAiContext(
  messages: ContextMessage[],
  namesById: Map<string, string>,
  opts: AiContextOptions = {},
): string {
  const lines = messages.map((m) => {
    const name = namesById.get(m.authorId) ?? "User";
    return `${name}: ${resolveMentions(m.content, namesById)}`;
  });
  const preamble: string[] = [];
  if (opts.channelName) preamble.push(`Channel: #${opts.channelName}`);
  if (opts.channelTopic) preamble.push(`Topic: ${opts.channelTopic}`);
  return preamble.length
    ? `${preamble.join("\n")}\n\n${lines.join("\n")}`
    : lines.join("\n");
}
