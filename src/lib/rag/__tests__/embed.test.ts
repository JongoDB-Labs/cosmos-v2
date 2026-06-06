// src/lib/rag/__tests__/embed.test.ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { embedText, cosineSimilarity, EMBED_DIM } from "../embed";

describe("embedText (real MiniLM)", () => {
  it("produces a normalized 384-dim vector", async () => {
    const v = await embedText("quarterly revenue planning");
    expect(v).toHaveLength(EMBED_DIM);
    expect(EMBED_DIM).toBe(384);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 1); // normalized
  }, 60_000); // first call may cold-load the model

  it("captures semantic similarity (paraphrase > unrelated)", async () => {
    const [a, b, c] = await Promise.all([
      embedText("quarterly revenue"),
      embedText("income for the quarter"),
      embedText("the weather is sunny"),
    ]);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c) + 0.3);
  }, 60_000);
});
