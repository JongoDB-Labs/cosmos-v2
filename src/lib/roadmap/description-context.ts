/**
 * Roadmap "context block" builder for issue descriptions.
 *
 * Turns the bare roadmap short-refs a backlog item carries (its Sprint / LOE /
 * Labels / imported Description — e.g. "DP-04", "R-19", "SP-3", "LOE-2") into a
 * populated **Roadmap context** block: a deep-link to each referenced RoadmapNode
 * PLUS an expanded gloss of what it actually is (a decision's default, a risk's
 * likelihood/impact + mitigation) — never just "DP-XX". Optionally appends the
 * matching COA-1 POA&M activities. See COSMOS-35.
 *
 * This module is intentionally PURE (no Prisma / IO) so it is unit-testable and
 * reusable by:
 *   - the backfill CLI (`scripts/roadmap/backfill-descriptions.ts`), which reads
 *     RoadmapNodes from the tenant DB and writes work_items.description, and
 *   - any future server surface that wants to compose the same block.
 *
 * Real customer roadmap/POA&M CONTENT is never committed — this file only holds
 * the transform; the data flows in from the tenant DB / an operator-supplied file
 * at runtime (see the CLI header).
 */

/** Idempotency markers — a re-run replaces the block between them, never dupes. */
export const ROADMAP_CONTEXT_START = "<!-- roadmap-context:start -->";
export const ROADMAP_CONTEXT_END = "<!-- roadmap-context:end -->";

/** The subset of a RoadmapNode this builder needs. */
export interface RoadmapContextNode {
  externalRef: string | null;
  anchor: string;
  title: string;
  body?: string | null;
  /** Kind-specific extras — decisions carry `default`, risks `likelihood`/`impact`/`mitigation`. */
  meta?: Record<string, unknown> | null;
}

/** One COA-1 POA&M activity (operator-supplied, keyed by LOE + optional sub-phase). */
export interface PoamActivity {
  /** LOE key, tolerant of "LOE-1" / "LOE1" / "1". */
  loe: string;
  /** Sub-phase span this activity belongs to, e.g. "0", "1-2", "BG-1" (optional). */
  sp?: string | null;
  task: string;
  owner?: string | null;
  target?: string | null;
  status?: string | null;
}

/** Short-refs derived from a work item's roadmap-bearing fields. */
export interface DerivedRefs {
  /** e.g. "LOE-1" (canonicalised) or null. */
  loe: string | null;
  /** e.g. "SP-0" / "SP-BG-1" or null. */
  subPhase: string | null;
  /** Decision refs in first-seen order, e.g. ["DP-04", "DP-13"]. */
  decisions: string[];
  /** Risk refs in first-seen order, e.g. ["R-19"]. */
  risks: string[];
}

/** Fields a backlog item exposes that may carry roadmap short-refs. */
export interface RefSourceFields {
  /** The item's LOE column (searched first for the LOE number). */
  loe?: string | null;
  /** The item's Sprint column (preferred source of the sub-phase). */
  sprint?: string | null;
  /** The item's Labels column (fallback source of the sub-phase). */
  labels?: string | null;
  /** Free-text blob (Summary + Source + Description + EpicLink …) scanned for DP/R refs. */
  text?: string | null;
}

// Sub-phase: "SP-0", "SP-3", "SP-BG-1". DP: "DP-04", "DP-AKS-1", "DP-13a".
// Risk: "R-19", "R-3a". LOE: "LOE-1" / "LOE 2" / "LOE3".
const SP_RE = /\bSP-(?:BG-)?[0-9A-Z]+\b/;
const DP_RE = /\bDP-[A-Za-z0-9-]+\b/g;
const R_RE = /\bR-\d+[ab]?\b/g;
const LOE_RE = /\bLOE[ -]?([123])\b/;

function str(v: string | null | undefined): string {
  return v == null ? "" : String(v);
}

/**
 * Extract the roadmap short-refs a backlog item carries. Faithful to the program
 * backfill heuristic: LOE from the LOE column (then anywhere), sub-phase from the
 * Sprint column (then Labels), decisions/risks from the free-text blob — each
 * de-duplicated in first-seen order.
 */
export function deriveRoadmapRefs(fields: RefSourceFields): DerivedRefs {
  const blob = [fields.text, fields.labels, fields.sprint, fields.loe]
    .map(str)
    .join(" ");

  const loeMatch = (str(fields.loe) + " " + blob).match(LOE_RE);
  const loe = loeMatch ? `LOE-${loeMatch[1]}` : null;

  const spMatch = str(fields.sprint).match(SP_RE) ?? str(fields.labels).match(SP_RE);
  const subPhase = spMatch ? spMatch[0] : null;

  const decisions = dedupe(blob.match(DP_RE) ?? []);
  const risks = dedupe(blob.match(R_RE) ?? []);

  return { loe, subPhase, decisions, risks };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

function metaStr(node: RoadmapContextNode, key: string): string | undefined {
  const v = node.meta?.[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Collapse a snippet to a single trimmed line, inline markdown removed, truncated on a word. */
export function clean(text: string, max = 200): string {
  let t = (text ?? "").replace(/^#+\s+/gm, ""); // strip line-start md headers only
  t = t.replace(/\*\*|`/g, "");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    t = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
  }
  return t;
}

/** A node body's prose, minus a leading "Likelihood: … Impact: X" preamble. */
export function excerpt(body: string | null | undefined, max = 200): string {
  const stripped = clean(body ?? "", 10_000).replace(/^Likelihood:.*?Impact:\s*\S+\s*/i, "").trim();
  return clean(stripped, max);
}

/** Concise decision gloss — the "default if not decided", not a restated title. */
export function decisionGloss(node: RoadmapContextNode): string {
  const def = metaStr(node, "default");
  if (def) return `Default: ${clean(def)}`;
  const fromBody = str(node.body).match(/\*\*Default if not decided:\*\*\s*(.+)/i);
  if (fromBody) return `Default: ${clean(fromBody[1])}`;
  return excerpt(node.body);
}

/** Concise risk gloss — likelihood/impact + mitigation. */
export function riskGloss(node: RoadmapContextNode): string {
  const parts: string[] = [];
  const likelihood = metaStr(node, "likelihood");
  const impact = metaStr(node, "impact");
  if (likelihood && impact) parts.push(`${likelihood}/${impact}`);
  const mitigation = metaStr(node, "mitigation") ?? str(node.body).match(/\*\*Mitigation:\*\*\s*(.+)/i)?.[1];
  if (mitigation) parts.push(`Mitigation: ${clean(mitigation)}`);
  return parts.length ? parts.join(" · ") : excerpt(node.body);
}

/** A markdown deep-link to a node's roadmap page: `[Title](basePath/anchor)`. */
export function roadmapLink(node: RoadmapContextNode, basePath: string): string {
  return `[${node.title}](${basePath.replace(/\/+$/, "")}/${node.anchor})`;
}

/**
 * Resolve a raw short-ref to the RoadmapNode externalRefs it stands for, honouring
 * caller-supplied aliases (e.g. a backlog-only "DP-33" that maps to a set of real
 * v8.0 nodes) and a trailing "-ref" suffix ("DP-AKS-1-ref" → "DP-AKS-1").
 */
export function resolveRef(
  ref: string,
  nodesByRef: Map<string, RoadmapContextNode>,
  aliases: Record<string, string[]> = {},
): string[] {
  if (nodesByRef.has(ref)) return [ref];
  if (aliases[ref]) return aliases[ref].filter((r) => nodesByRef.has(r));
  const stripped = ref.replace(/-ref$/, "");
  if (stripped !== ref && nodesByRef.has(stripped)) return [stripped];
  return [];
}

/** Select up to `limit` POA&M activities matching this item's LOE (and sub-phase, if any). */
export function poamFor(
  loe: string | null,
  subPhase: string | null,
  poam: PoamActivity[],
  limit = 3,
): PoamActivity[] {
  if (!loe) return [];
  const loeKey = loe.replace(/-/g, ""); // "LOE-1" → "LOE1"
  const norm = (v: string) => v.replace(/-/g, "");
  let rows = poam.filter((t) => norm(str(t.loe)) === loeKey || norm(str(t.loe)) === loeKey.replace("LOE", ""));
  const spNum = subPhase ? subPhase.replace(/SP-?/i, "") : "";
  if (spNum) {
    const exact = rows.filter((t) => str(t.sp).split(/[-–]/).includes(spNum));
    if (exact.length) rows = exact;
  }
  return rows.slice(0, limit);
}

export interface BuildBlockOptions {
  refs: DerivedRefs;
  nodesByRef: Map<string, RoadmapContextNode>;
  basePath: string;
  poam?: PoamActivity[];
  aliases?: Record<string, string[]>;
  /** Cite line, defaults to the VITL-BMA sources this feature targets. */
  sourceLabel?: string;
  /** Cap on decisions/risks listed (default 6). */
  maxItems?: number;
}

/**
 * Compose the "Roadmap context" block for one item, or null when none of its refs
 * resolve to a known node (so callers can skip untouched items). The block is
 * wrapped in the idempotency markers.
 */
export function buildRoadmapContextBlock(opts: BuildBlockOptions): string | null {
  const {
    refs,
    nodesByRef,
    basePath,
    poam = [],
    aliases = {},
    sourceLabel = "VITL-BMA Technical Roadmap v8.0 + COA-1 POA&M",
    maxItems = 6,
  } = opts;

  const lines: string[] = [ROADMAP_CONTEXT_START, "", "---", "### 📍 Roadmap context", ""];
  let anyRef = false;

  const loeNode = refs.loe ? nodesByRef.get(refs.loe) : undefined;
  if (loeNode) {
    lines.push(`**Line of Effort:** ${roadmapLink(loeNode, basePath)}`);
    anyRef = true;
  }
  const spNode = refs.subPhase ? nodesByRef.get(refs.subPhase) : undefined;
  if (spNode) {
    lines.push(`**Sub-phase:** ${roadmapLink(spNode, basePath)}`);
    anyRef = true;
  }

  const decisionRefs = dedupe(refs.decisions.flatMap((r) => resolveRef(r, nodesByRef, aliases)));
  if (decisionRefs.length) {
    lines.push("", "**Decisions (source of truth):**");
    for (const r of decisionRefs.slice(0, maxItems)) {
      const node = nodesByRef.get(r)!;
      lines.push(`- ${roadmapLink(node, basePath)} — ${decisionGloss(node)}`);
    }
    anyRef = true;
  }

  const riskRefs = dedupe(refs.risks.flatMap((r) => resolveRef(r, nodesByRef, aliases)));
  if (riskRefs.length) {
    lines.push("", "**Risks (source of truth):**");
    for (const r of riskRefs.slice(0, maxItems)) {
      const node = nodesByRef.get(r)!;
      lines.push(`- ${roadmapLink(node, basePath)} — ${riskGloss(node)}`);
    }
    anyRef = true;
  }

  const activities = poamFor(refs.loe, refs.subPhase, poam);
  if (activities.length) {
    const loeLbl = str(refs.loe).replace(/-/g, " ");
    lines.push("", `**Related COA-1 POA&M activities (${loeLbl}):**`);
    for (const t of activities) {
      const bits = [t.owner, t.target].map(str).filter(Boolean).join(" · ");
      const status = t.status ? ` · _${clean(t.status)}_` : "";
      lines.push(`- ${clean(t.task)}${bits ? ` — ${bits}` : ""}${status}`);
    }
    anyRef = true;
  }

  if (!anyRef) return null;
  lines.push("", `_Source of truth: ${sourceLabel}._`, ROADMAP_CONTEXT_END);
  return lines.join("\n");
}

/** Remove a previously-appended context block (between the markers), if present. */
export function stripRoadmapContext(description: string): string {
  if (description.includes(ROADMAP_CONTEXT_START) && description.includes(ROADMAP_CONTEXT_END)) {
    const re = new RegExp(
      escapeRegExp(ROADMAP_CONTEXT_START) + "[\\s\\S]*?" + escapeRegExp(ROADMAP_CONTEXT_END),
    );
    return description.replace(re, "").replace(/\s+$/, "");
  }
  return description;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splice a fresh context block into a description, idempotently. Any prior block is
 * stripped first (so re-running never duplicates), the user's own prose is kept,
 * and the block is appended after it. A null block leaves only the stripped prose.
 */
export function applyRoadmapContext(description: string | null | undefined, block: string | null): string {
  const stripped = stripRoadmapContext(description ?? "");
  if (!block) return stripped;
  return stripped.trim() ? `${stripped}\n\n${block}`.trim() : block;
}
