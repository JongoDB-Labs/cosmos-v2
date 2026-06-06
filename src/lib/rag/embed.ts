// src/lib/rag/embed.ts
//
// Real in-boundary sentence embeddings (Xenova/all-MiniLM-L6-v2, 384-dim) via
// @huggingface/transformers running in-process on CPU. No external API. The model
// is lazy-loaded once per process and bundled into the Docker image for gov
// (HF_HUB_OFFLINE=1) so it never phones home at runtime.

import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBED_DIM = 384;
const MODEL = "Xenova/all-MiniLM-L6-v2";

let _pipe: Promise<FeatureExtractionPipeline> | null = null;
function pipe(): Promise<FeatureExtractionPipeline> {
  if (!_pipe) {
    // Imported lazily so the (heavy) ONNX runtime only loads when embeddings are used.
    _pipe = import("@huggingface/transformers").then(({ pipeline }) =>
      pipeline("feature-extraction", MODEL),
    );
  }
  return _pipe;
}

/** Embed text → a normalized 384-dim vector (mean-pooled). Truncates very long input. */
export async function embedText(text: string): Promise<number[]> {
  const input = (text ?? "").slice(0, 8000); // guard pathological lengths
  const extractor = await pipe();
  const output = await extractor(input, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** SQL literal for a pgvector parameter: '[0.1,0.2,...]'. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** The tables that carry a pgvector `embedding` column. Fixed union — never user input. */
export type EmbeddableTable = "notes" | "work_items" | "contracts" | "sync_meetings";

/**
 * Embed-on-write: compute the 384-dim embedding for `text` and persist it to the
 * given row's `embedding` column via raw SQL. `table` is a fixed union (never user
 * input) so interpolating the identifier is safe; the vector + id are bound params.
 *
 * MUST be called AFTER the row exists (it's an UPDATE). Best-effort: callers
 * typically `.catch()` so an embed failure never breaks the user-facing write.
 */
export async function storeEmbedding(
  table: EmbeddableTable,
  id: string,
  text: string,
): Promise<void> {
  // Imported lazily to avoid a static import cycle (db/client → … → rag) and to
  // keep this module importable in contexts without the Prisma client.
  const { prisma } = await import("@/lib/db/client");
  const vec = toVectorLiteral(await embedText(text));
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET "embedding" = $1::vector WHERE "id" = $2::uuid`,
    vec,
    id,
  );
}
