// src/lib/classification/classifier.ts
//
// COARSE in-boundary content classifier — the embeddings-similarity half of the
// DLP tripwire. Embeds a candidate string and flags it if it is semantically
// close to a seeded set of controlled/defense reference phrases. DETECTOR ONLY:
// callers use it to turn allow→deny; it never exposes more. It is defense-in-depth
// beneath the deterministic marking-DLP + classification-ceiling floors — NOT a
// precise CUI oracle. Over-flagging is safe (over-withhold).

import { embedText, cosineSimilarity } from "@/lib/rag/embed";

// Seed reference phrases representative of CUI/defense-sensitive content. Tune as
// needed; more/clearer seeds + a calibrated threshold improve precision.
const CUI_SEEDS = [
  "controlled unclassified information",
  "weapon system targeting parameters and kill chain",
  "classified defense program technical specifications",
  "personally identifiable information social security number",
  "export-controlled ITAR technical data",
  "force deployment troop movement operational plan",
  "vulnerability assessment of critical infrastructure",
];
const THRESHOLD = Number(process.env.CUI_CLASSIFIER_THRESHOLD ?? "0.45");

let _seeds: Promise<number[][]> | null = null;
function seeds(): Promise<number[][]> {
  if (!_seeds) _seeds = Promise.all(CUI_SEEDS.map((s) => embedText(s)));
  return _seeds;
}

/** True if `text` is semantically close to seeded controlled-content references. */
export async function classifyLikelyCui(text: string): Promise<boolean> {
  const t = (text ?? "").trim();
  if (!t) return false;
  const [v, refs] = await Promise.all([embedText(t), seeds()]);
  let max = 0;
  for (const r of refs) { const c = cosineSimilarity(v, r); if (c > max) max = c; }
  return max >= THRESHOLD;
}
