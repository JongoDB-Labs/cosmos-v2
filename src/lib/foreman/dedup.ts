export interface Candidate {
  ref: string;
  title: string;
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

/** Cheap first pass: keep candidates whose title overlaps the ticket enough to be
 *  worth a semantic check. Sorted by descending overlap. */
export function prefilter(title: string, candidates: Candidate[], threshold = 0.5): Candidate[] {
  return candidates
    .map((c) => ({ c, o: tokenOverlap(title, c.title) }))
    .filter((x) => x.o >= threshold)
    .sort((x, y) => y.o - x.o)
    .map((x) => x.c);
}
