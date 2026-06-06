// Semantic search "embeddings" for cosmos.
//
// TODO(rag): replace this with a real embedding model. Two paths considered:
//   - pgvector(384) + @xenova/transformers `Xenova/all-MiniLM-L6-v2`. Best
//     accuracy, but requires installing pgvector on Postgres AND pulling in
//     ~46 MB of JS + ~80 MB of model weights at first server start. Both
//     are blocked in this iteration (pgvector isn't installed; the heavy
//     install is out of scope per the task description).
//   - A Claude/Anthropic embeddings API. There isn't one today (Voyage AI
//     was acquired but cosmos doesn't ship a Voyage key), so this would
//     mean adding a new vendor + secret.
//
// Until then we ship a deliberately tiny "token-bag" pseudo-embedding:
// lowercase + strip punctuation + drop stopwords + TF count per unique
// token. Search uses cosine similarity over the sparse intersection of
// tokens (see `cosineSimilarity` below). This is keyword overlap dressed
// up as a vector — it won't catch semantic paraphrase ("revenue" ≠
// "income"), but it works without any DB extension or model download
// and degrades gracefully to "find me notes that literally mention Q4
// planning" which is the most common query shape.
//
// Storage shape on disk (Note.searchVector, WorkItem.searchVector, …):
//   { tokens: string[]; tf: number[] }   // parallel arrays, same length
// Versioned implicitly — `embedText` always emits this shape, and the
// search executor in src/lib/ai/executors/rag.ts assumes it.

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "he", "her", "his", "i", "in", "is", "it", "its", "of",
  "on", "or", "she", "that", "the", "their", "them", "they", "this",
  "to", "was", "we", "were", "will", "with", "you", "your", "our", "us",
  "if", "then", "than", "so", "do", "does", "did", "not", "no", "yes",
  "can", "could", "would", "should", "may", "might", "shall", "must",
  "been", "being", "had", "having", "i'm", "i've", "i'll", "you're",
  "we're", "they're",
]);

const MAX_INPUT_CHARS = 8000;
const MAX_TOKENS_PER_VECTOR = 256;

/**
 * On-disk embedding shape. See file header for the rationale on why this is
 * a sparse token-frequency bag rather than a dense float[384].
 */
export interface SearchVector {
  tokens: string[];
  tf: number[];
}

/** True if a JSON blob loaded from Prisma looks like a SearchVector. */
export function isSearchVector(v: unknown): v is SearchVector {
  if (!v || typeof v !== "object") return false;
  const sv = v as Partial<SearchVector>;
  return (
    Array.isArray(sv.tokens) &&
    Array.isArray(sv.tf) &&
    sv.tokens.length === sv.tf.length &&
    sv.tokens.every((t) => typeof t === "string") &&
    sv.tf.every((n) => typeof n === "number")
  );
}

/**
 * Tokenize: lowercase, split on non-alphanumeric, drop stopwords and
 * single-char tokens. The 2-char floor keeps domain shorthand intact
 * ("q4", "v2", "ui", "p1") while still pruning most noise.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Produce a SearchVector for `text`. Truncates input to MAX_INPUT_CHARS to
 * keep the pseudo-embed bounded, and caps the vector at MAX_TOKENS_PER_VECTOR
 * unique tokens (highest-frequency first) so an enormous note doesn't bloat
 * the JSONB column unbounded.
 *
 * Async because the real-embeddings replacement will be async — keeping
 * the same signature now means swapping in `pipeline(...)` later is a one-
 * file change.
 */
export async function embedText(text: string): Promise<SearchVector> {
  if (!text || typeof text !== "string") {
    return { tokens: [], tf: [] };
  }
  const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  const tokens = tokenize(truncated);
  if (tokens.length === 0) return { tokens: [], tf: [] };

  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);

  // Keep the top MAX_TOKENS_PER_VECTOR by frequency. For most rows we're far
  // under the cap; epic-sized notes can otherwise produce ~2 KB JSON blobs.
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const kept = sorted.slice(0, MAX_TOKENS_PER_VECTOR);

  return {
    tokens: kept.map(([t]) => t),
    tf: kept.map(([, n]) => n),
  };
}

/**
 * Cosine similarity between two SearchVectors.
 *
 * Works on the sparse intersection — we don't materialize the full
 * vocabulary vector. Returns a number in [0, 1]; 0 means no shared tokens,
 * 1 means identical token bags.
 *
 * For empty vectors returns 0 (rather than NaN) so callers can rank safely.
 */
export function cosineSimilarity(a: SearchVector, b: SearchVector): number {
  if (a.tokens.length === 0 || b.tokens.length === 0) return 0;

  // Build a lookup for the smaller vector so the intersection loop is O(min).
  const [small, large] =
    a.tokens.length <= b.tokens.length ? [a, b] : [b, a];
  const smallLookup = new Map<string, number>();
  for (let i = 0; i < small.tokens.length; i++) {
    smallLookup.set(small.tokens[i], small.tf[i]);
  }

  let dot = 0;
  for (let i = 0; i < large.tokens.length; i++) {
    const w = smallLookup.get(large.tokens[i]);
    if (w !== undefined) dot += w * large.tf[i];
  }
  if (dot === 0) return 0;

  let normA = 0;
  for (const n of a.tf) normA += n * n;
  let normB = 0;
  for (const n of b.tf) normB += n * n;

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Convenience: best-effort wrapper that swallows errors. Embed-on-write
 * callers use this so a tokenizer hiccup never breaks the user-facing
 * create/update flow.
 */
export async function safeEmbedText(text: string): Promise<SearchVector | null> {
  try {
    return await embedText(text);
  } catch (err) {
    console.warn("[rag] embedText failed:", (err as Error).message);
    return null;
  }
}
