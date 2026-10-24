/**
 * Split per assignee (COSMOS-89): one item shared by several people becomes one
 * item each, so each person's work can be tracked, estimated and closed on its
 * own. Explicit, never automatic: multi-assignee stays a real choice.
 *
 * The original keeps its FIRST assignee (the set is read in sortOrder, and
 * that head is the one `assigneeId` mirrors); everyone after that gets a copy.
 */
export function planSplit(assigneeIds: string[]): { keep: string; splitOff: string[] } | null {
  const unique = [...new Set(assigneeIds)];
  if (unique.length < 2) return null;
  const [keep, ...splitOff] = unique;
  return { keep, splitOff };
}
