// Comment intent classifier for the Foreman approval loop.
// Parses maintainer instructions in ticket comments to extract approval,
// rebuild, or general instruction intents.

export type CommentIntent = "approve" | "rebuild" | "instruct";

/** Strip leading mention token (<@uuid> or @foreman, case-insensitive) and
 * surrounding whitespace/punctuation. Only strips trailing punctuation if a
 * token was actually removed (so "approve?" stays "approve?" and won't match
 * the approve pattern, which only tolerates [.!\s] trailing chars). */
function stripMentionToken(text: string): string {
  let result = text.trim();

  // Try to strip <@...> token (e.g., <@123e4567-e89b-12d3-a456-426614174000>)
  const uuidTokenMatch = result.match(/^<@[^>]+>/);
  if (uuidTokenMatch) {
    result = result.slice(uuidTokenMatch[0].length);
    // Strip separator (whitespace, period, colon, comma) that follows the removed token
    result = result.replace(/^[\s.:,]+/, "");
  } else {
    // Try to strip @foreman token (case-insensitive)
    const atForemanMatch = result.match(/^@foreman/i);
    if (atForemanMatch) {
      result = result.slice(atForemanMatch[0].length);
      // Strip separator (whitespace, period, colon, comma) that follows the removed token
      result = result.replace(/^[\s.:,]+/, "");
    } else {
      // No token was stripped, only trim whitespace (not punctuation)
      result = result.trim();
    }
  }

  return result;
}

/** Classify a single instruction text into an intent.
 * - If remainder after stripping mention token matches approve pattern → "approve"
 * - Else if it contains a whole-word rebuild keyword → "rebuild"
 * - Else → "instruct"
 */
export function classifyInstruction(text: string): CommentIntent {
  const stripped = stripMentionToken(text);

  // Check for approve pattern: approved?, lgtm, ship it/shipit, emoji thumbsup, or :+1:
  // Must be a complete match (possibly with trailing punctuation/whitespace)
  const approvePattern = /^(approved?|lgtm|ship\s?it|👍|:\+1:)[.!\s]*$/i;
  if (approvePattern.test(stripped)) {
    return "approve";
  }

  // Check for rebuild keywords (whole-word match)
  const rebuildPattern = /\b(rebuild|start over|from scratch|requeue)\b/i;
  if (rebuildPattern.test(stripped)) {
    return "rebuild";
  }

  // Default to instruct
  return "instruct";
}

/** Combine multiple instruction texts into a single combined intent.
 * Priority: approve (if any) > rebuild (if any) > instruct (default).
 * For approve: instructions are empty (approval needs no additional context).
 * For rebuild or instruct: all original texts are returned in order.
 */
export function combineIntents(texts: string[]): { intent: CommentIntent; instructions: string[] } {
  const intents = texts.map(classifyInstruction);

  // Priority: approve > rebuild > instruct
  if (intents.includes("approve")) {
    return { intent: "approve", instructions: [] };
  }

  if (intents.includes("rebuild")) {
    return { intent: "rebuild", instructions: texts };
  }

  return { intent: "instruct", instructions: texts };
}
