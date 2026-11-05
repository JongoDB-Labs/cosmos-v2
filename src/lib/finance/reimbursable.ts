/**
 * A reimbursable cost is one billed back to the client at cost plus the
 * project's markup. It is a project's by definition: with no project there is
 * nobody to bill it to, so the pair is refused rather than silently stored.
 */
export const REIMBURSABLE_NEEDS_PROJECT = "A reimbursable expense needs a project to bill it to.";

export function reimbursableNeedsProject(): Response {
  return new Response(JSON.stringify({ error: REIMBURSABLE_NEEDS_PROJECT }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}
