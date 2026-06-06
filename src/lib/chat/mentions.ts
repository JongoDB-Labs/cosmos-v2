/**
 * Mention tokens embed as `<@uuid>` in message bodies. The frontend mention
 * picker produces these tokens; the server parses them out to materialize
 * `ChatMessageMention` rows and decide notification fan-out.
 *
 * The regex uses the `g` flag (so `matchAll` returns all hits) and the `i`
 * flag (so hex letters can be A-F or a-f). The captured group is the UUID
 * which is normalized to lowercase by `parseMentions`.
 */
export const MENTION_RE =
  /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

export function parseMentions(content: string): string[] {
  if (!content) return [];
  MENTION_RE.lastIndex = 0;
  const out = new Set<string>();
  for (const m of content.matchAll(MENTION_RE)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}
