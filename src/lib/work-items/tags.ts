/**
 * Managed tag vocabulary for work items (COSMOS-93).
 *
 * Work items already carry a free-form `tags: String[]`, and the Issues view can
 * already filter by them. What was missing was a way to CURATE that vocabulary:
 * create a named tag (with an optional color) that exists independently of which
 * items use it, and delete a tag org-wide. This module models that registry as an
 * ORG-SCOPED list stored in `Organization.settings.tags` — no new table, so it
 * rides on the existing free-form tag strings rather than replacing them.
 *
 * Pure — no DB, no imports. The route reads/writes `org.settings`; every consumer
 * normalizes through here so the untrusted JSON shape is validated in exactly one
 * place (mirrors lib/feedback/automation-config.ts).
 */

export interface TagDef {
  /** Display + match value. Equal to the string stored in `WorkItem.tags`. */
  name: string;
  /** Hex color (`#rgb` or `#rrggbb`, lowercased), or null for an uncolored tag. */
  color: string | null;
}

/** Longest a tag name may be (kept short so chips stay readable). */
export const MAX_TAG_NAME_LEN = 40;
/** Sanity cap on how many tags an org may define (bounds the settings blob). */
export const MAX_TAGS = 200;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trim, collapse internal whitespace, and cap the length. Returns "" for an
 *  unusable (non-string / empty) name. */
export function normalizeTagName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_NAME_LEN);
}

/** A well-formed hex color, normalized to lowercase — or null for anything else
 *  (empty string, non-hex, wrong length…). Color is always optional. */
export function normalizeColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return HEX_COLOR.test(value) ? value : null;
}

/** Normalize an org's `settings` JSON (unknown shape) into the tag registry.
 *  De-duplicates by name (case-insensitive, first wins), drops empty names, and
 *  caps the list — defensive against hand-edited / legacy settings blobs. */
export function readTagRegistry(settings: unknown): TagDef[] {
  const root = isRecord(settings) ? settings : {};
  const raw = Array.isArray(root.tags) ? root.tags : [];
  const out: TagDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    // Tolerate both the rich `{ name, color }` shape and a bare string.
    const name = normalizeTagName(isRecord(entry) ? entry.name : entry);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, color: normalizeColor(isRecord(entry) ? entry.color : null) });
  }
  return out.slice(0, MAX_TAGS);
}

/** Add a tag, or update its color + display case if the name already exists
 *  (case-insensitive). Returns a NEW list; never mutates the input. An empty
 *  name is a no-op (validation proper lives in the route). */
export function upsertTagDef(list: TagDef[], def: TagDef): TagDef[] {
  const name = normalizeTagName(def.name);
  if (!name) return list;
  const color = normalizeColor(def.color);
  const key = name.toLowerCase();
  let found = false;
  const next = list.map((t) => {
    if (t.name.toLowerCase() === key) {
      found = true;
      return { name, color };
    }
    return t;
  });
  if (!found) next.push({ name, color });
  return next.slice(0, MAX_TAGS);
}

/** Remove a tag by name (case-insensitive). Returns a NEW list. */
export function removeTagDef(list: TagDef[], name: string): TagDef[] {
  const key = normalizeTagName(name).toLowerCase();
  if (!key) return list;
  return list.filter((t) => t.name.toLowerCase() !== key);
}
