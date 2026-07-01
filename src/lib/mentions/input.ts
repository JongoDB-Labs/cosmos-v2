/**
 * Plain-textarea @-mention helpers (chat composer, comment box, assistant
 * input). PURE. The Lexical notes editor uses its own plugin, not these.
 */
import { buildToken, type EntityType } from "./refs";

/** The active @-query at the caret, or null. Ends at whitespace, so the user
 *  types a keyword after `@` and picks from the typeahead. */
export function detectMentionQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const m = before.match(/(?:^|\s)@([\w-]*)$/);
  return m ? m[1] : null;
}

/** Replace the active `@query` at the caret with a canonical mention token
 *  (plus a trailing space) and report the new caret position. */
export function insertMentionToken(
  text: string,
  caret: number,
  type: EntityType,
  id: string,
): { value: string; caret: number } {
  const token = `${buildToken(type, id)} `;
  const before = text
    .slice(0, caret)
    .replace(/(?:^|\s)@([\w-]*)$/, (m) => m.replace(/@[\w-]*$/, token));
  const after = text.slice(caret);
  return { value: before + after, caret: before.length };
}
