import {
  ENTITY_LABEL,
  ENTITY_PREFIX,
  TOKEN_RE,
  isEntityType,
  refKey,
  type EntityType,
} from "./refs";

/**
 * Render a body's mention tokens as readable text.
 *
 * For places that cannot render React chips — notification titles and bodies,
 * push payloads, AI prompts, Teams cards. The stored form is an id
 * (`<@uuid>` for a person, `<@type:id>` for anything else) precisely so the
 * label can change without rewriting content; the cost is that every plain-text
 * consumer has to resolve it, and five of them were not.
 *
 * ## What this replaces
 *
 * Five call sites each carried the same line:
 *
 *     content.replace(/<@[0-9a-f-]{36}>/gi, "@user")
 *
 * Two defects in it. It rendered a hardcoded `"@user"`, so a notification read
 * "@user please review" and never told the recipient who was actually
 * addressed — including themselves. And it matched ONLY the legacy 36-character
 * people form, so a typed token (`<@workItem:…>`, `<@project:…>`) survived
 * verbatim and a raw uuid was shown to the reader.
 *
 * One function, one behaviour, and a raw id can never reach a reader from any
 * of them.
 */

/**
 * @param content  the stored body
 * @param labels   `refKey(type, id)` → display label. The same keying
 *                 `useRefResolver` and `MarkdownContent` use, so a caller can
 *                 pass a map it already has. Omit it to get the safe generic
 *                 fallbacks below.
 */
export function mentionsToPlainText(
  content: string,
  labels?: ReadonlyMap<string, string>,
): string {
  if (!content) return "";
  // A fresh regex per call: TOKEN_RE is a module-level /g literal, and sharing
  // its `lastIndex` across calls makes the SECOND caller skip the start of its
  // own string. `parseRefs` clones it for the same reason.
  const re = new RegExp(TOKEN_RE.source, "gi");
  return content.replace(re, (_full, rawType: string | undefined, id: string) => {
    const type: EntityType = isEntityType(rawType) ? rawType : "user";
    const label = labels?.get(refKey(type, id));
    if (label) return `${ENTITY_PREFIX[type]}${label}`;
    // Unresolved. Never fall through to the id — a uuid in a notification body
    // is noise to a person and a small leak of internal identifiers.
    return type === "user"
      ? "@someone"
      : `${ENTITY_PREFIX[type]}${ENTITY_LABEL[type].toLowerCase()}`;
  });
}

/**
 * Build the label map for a set of people.
 *
 * Every notification call site already loads the mentioned org members to
 * decide the fan-out; this turns that same list into the map, so resolving the
 * snippet costs no extra query — only a wider `select`.
 */
export function userMentionLabels(
  users: ReadonlyArray<{ id: string; displayName: string }>,
): Map<string, string> {
  return new Map(users.map((u) => [refKey("user", u.id), u.displayName]));
}
