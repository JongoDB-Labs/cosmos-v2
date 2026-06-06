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
