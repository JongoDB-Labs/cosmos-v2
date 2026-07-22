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
 * - Else if the remainder IS a standalone rebuild command → "rebuild"
 * - Else → "instruct"
 *
 * Rebuild is anchored (full-match) exactly like approve: a comment must *be* a
 * rebuild command, not merely mention one. A loose substring match would let a
 * hedged or mid-sentence mention like "no need to rebuild everything" or
 * "let's not start over, just fix the header" tear down and requeue the parked
 * build the maintainer was trying to refine. Anything that only *contains* a
 * rebuild keyword rides in as an "instruct" so it resumes the build instead.
 */
export function classifyInstruction(text: string): CommentIntent {
  const stripped = stripMentionToken(text);

  // Check for approve pattern: approved?, lgtm, ship it/shipit, emoji thumbsup, or :+1:
  // Must be a complete match (possibly with trailing punctuation/whitespace)
  const approvePattern = /^(approved?|lgtm|ship\s?it|👍|:\+1:)[.!\s]*$/i;
  if (approvePattern.test(stripped)) {
    return "approve";
  }

  // Check for a standalone rebuild command — full match, like approve above.
  // Must BE the command (optionally prefixed with "please"), not merely contain
  // a rebuild keyword somewhere in a larger sentence.
  const rebuildPattern = /^(please\s+)?(rebuild|start over|from scratch|requeue)[.!\s]*$/i;
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

/** Whether a maintainer's @foreman command on a COORDINATED PHASE CHILD should be
 *  honored as an ACTION even though the child is NOT in the `review` column (#2).
 *  A coordinated phase child is routinely held OUTSIDE `review` — in `done`
 *  (already-merged/marked-ready) or `backlog`/`todo` while its siblings finish — so
 *  an approve/rebuild comment on it would otherwise fall through to the read-only
 *  Q&A path and never act. True only when ALL hold: the child is off `review`, it
 *  IS a coordinated phase child, and the combined intent is an actionable `approve`
 *  or `rebuild`. A bare `instruct` (a question / steering note) off `review` stays
 *  Q&A — we never resume-build a non-review ticket from this path. In `review` the
 *  normal router already handles every intent, so this returns false there (no
 *  double-handling). Pure — the caller (run.mts) supplies isCoordinatedPhaseChild
 *  from db.isCoordinatedPhaseChild. */
export function honorPhaseCommand(
  columnKey: string,
  intent: CommentIntent,
  isCoordinatedPhaseChild: boolean,
): boolean {
  if (columnKey === "review") return false;
  if (!isCoordinatedPhaseChild) return false;
  return intent === "approve" || intent === "rebuild";
}
