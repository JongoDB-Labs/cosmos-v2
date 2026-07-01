/**
 * Entity-reference tokens for @-mentions across every surface (chat, comments,
 * Lexical notes, assistant). Backward-compatible with the original people-only
 * `<@uuid>` token:
 *
 *   - `user` mentions still serialize as `<@<uuid>>` (no type prefix) — so all
 *     existing content, the person-notification fan-out (`chat/mentions.ts`
 *     `parseMentions`), and the legacy renderer keep working unchanged.
 *   - every other entity type serializes as `<@<type>:<id>>`
 *     (e.g. `<@workItem:UUID>`, `<@project:UUID>`, `<@note:UUID>`).
 *
 * Stored id-only (stable + canonical) — labels are resolved at render time and
 * the id powers deep-links and "mentioned-in" backlinks. This module is PURE
 * (no server/client deps) so it can be imported anywhere.
 */

export const ENTITY_TYPES = [
  "user",
  "workItem",
  "project",
  "note",
  "meeting",
  "board",
  "milestone",
  "objective",
  "goal",
  "kpi",
  "document",
  "risk",
  "deliverable",
  "blocker",
  "changeRequest",
  "clin",
  "crmContact",
  "partner",
  "product",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

const TYPE_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);
export function isEntityType(s: unknown): s is EntityType {
  return typeof s === "string" && TYPE_SET.has(s);
}

export type EntityRef = { type: EntityType; id: string };

/** A reference resolved to display + deep-link info (search hits + chip data). */
export type ResolvedEntity = {
  type: EntityType;
  id: string;
  label: string;
  sublabel?: string;
  url: string | null;
};

/** Short textual prefix for inline chips (pure data; safe to import anywhere). */
export const ENTITY_PREFIX: Record<EntityType, string> = {
  user: "@",
  workItem: "#",
  project: "▸",
  note: "🗎",
  meeting: "◷",
  board: "⊞",
  milestone: "⚑",
  objective: "◎",
  goal: "◈",
  kpi: "▨",
  document: "⛁",
  risk: "⚠",
  deliverable: "▤",
  blocker: "⛔",
  changeRequest: "⇄",
  clin: "§",
  crmContact: "☺",
  partner: "⬡",
  product: "⬢",
};

/** Human-readable singular label per type (used in picker groups + labels). */
export const ENTITY_LABEL: Record<EntityType, string> = {
  user: "Person",
  workItem: "Work item",
  project: "Project",
  note: "Note",
  meeting: "Meeting",
  board: "Board",
  milestone: "Milestone",
  objective: "Objective",
  goal: "Goal",
  kpi: "KPI",
  document: "Document",
  risk: "Risk",
  deliverable: "Deliverable",
  blocker: "Blocker",
  changeRequest: "Change request",
  clin: "CLIN",
  crmContact: "Contact",
  partner: "Partner",
  product: "Product",
};

/** Plural label per type (picker group headers). */
export const ENTITY_LABEL_PLURAL: Record<EntityType, string> = {
  user: "People",
  workItem: "Work items",
  project: "Projects",
  note: "Notes",
  meeting: "Meetings",
  board: "Boards",
  milestone: "Milestones",
  objective: "Objectives",
  goal: "Goals",
  kpi: "KPIs",
  document: "Documents",
  risk: "Risks",
  deliverable: "Deliverables",
  blocker: "Blockers",
  changeRequest: "Change requests",
  clin: "CLINs",
  crmContact: "Contacts",
  partner: "Partners",
  product: "Products",
};

/**
 * Display order for grouped results (people + work items + projects first —
 * the most-mentioned classes — then the rest).
 */
export const ENTITY_ORDER: EntityType[] = [
  "user",
  "workItem",
  "project",
  "note",
  "meeting",
  "board",
  "milestone",
  "objective",
  "goal",
  "kpi",
  "document",
  "risk",
  "deliverable",
  "blocker",
  "changeRequest",
  "clin",
  "crmContact",
  "partner",
  "product",
];

/**
 * Match an entity token. Group 1 = optional type; group 2 = id. A missing type
 * means the legacy people form → `user`. The id class covers UUIDs and cuid-ish
 * ids; the `<@ … >` wrapper keeps it from matching arbitrary prose.
 */
export const TOKEN_RE = /<@(?:([a-zA-Z][a-zA-Z0-9]*):)?([a-zA-Z0-9_-]+)>/g;

/** Serialize a reference to its canonical stored token. */
export function buildToken(type: EntityType, id: string): string {
  return type === "user" ? `<@${id}>` : `<@${type}:${id}>`;
}

/** A stable map key for a reference. */
export function refKey(type: EntityType, id: string): string {
  return `${type}:${id.toLowerCase()}`;
}

/**
 * Extract every distinct entity reference from content (deduped). Unknown type
 * prefixes fall back to `user` so a stray token never throws.
 */
export function parseRefs(content: string): EntityRef[] {
  if (!content) return [];
  const out: EntityRef[] = [];
  const seen = new Set<string>();
  const re = new RegExp(TOKEN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const type: EntityType = isEntityType(m[1]) ? m[1] : "user";
    const id = m[2];
    const key = refKey(type, id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id });
  }
  return out;
}
