export interface Candidate {
  ref: string;
  title: string;
  /** Ref of this candidate's own parent epic, when it is itself a decomposition
   *  child. Lets the gate spot siblings (same parent_id) and never dedup them
   *  against each other. Absent/null for top-level items. */
  parentRef?: string | null;
}

/** Lowercase, drop [bracketed] prefixes, collapse non-alphanumerics to spaces. */
export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOP = new Set(["the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "is", "be", "cant", "cannot", "not"]);

function tokens(t: string): Set<string> {
  return new Set(normalizeTitle(t).split(" ").filter((w) => w && !STOP.has(w)));
}

/** Overlap ratio over the smaller token set (0..1). Symmetric-ish; robust to length. */
export function tokenOverlap(a: string, b: string): number {
  const sa = tokens(a);
  const sb = tokens(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / Math.min(sa.size, sb.size);
}

/** Decomposition children are intentionally narrower scopes of their parent epic,
 *  not duplicates. Given the ticket's own parent ref, drop the parent epic itself
 *  (candidate.ref === parentRef) and every sibling child (same parentRef) from the
 *  candidate set so they are never judged duplicates. No-op for top-level tickets
 *  (no parentRef). */
export function excludeFamily(
  parentRef: string | null | undefined,
  candidates: Candidate[],
): Candidate[] {
  if (!parentRef) return candidates;
  return candidates.filter((c) => c.ref !== parentRef && c.parentRef !== parentRef);
}

/** Cheap first pass: keep candidates whose title overlaps the ticket enough to be
 *  worth a semantic check. Sorted by descending overlap. */
export function prefilter(title: string, candidates: Candidate[], threshold = 0.5): Candidate[] {
  return candidates
    .map((c) => ({ c, o: tokenOverlap(title, c.title) }))
    .filter((x) => x.o >= threshold)
    .sort((x, y) => y.o - x.o)
    .map((x) => x.c);
}
