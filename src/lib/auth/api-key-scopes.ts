/**
 * Client-safe API-key scope vocabulary — PURE constants, no server-only imports
 * (no prisma/crypto/session), so a client component (the Settings panel) can import
 * it without dragging the server auth graph into the browser bundle. The server lib
 * (`api-key.ts`) and the routes import these from here too.
 *
 * A scope does two things. It is a CEILING on the key's permissions (the bit
 * mask in api-key.ts, intersected with the minting user's own), and it is a
 * GATE on the public API: every operation's contract names the scopes a token
 * must hold (`x-cosmos-scopes` in the spec). The mask decides what the user
 * could do; the scope decides what this token was minted to do.
 */
export const API_KEY_SCOPES = [
  "read",
  "items:write",
  "items:delete",
  "planning:write",
  "documents:write",
  "time:read",
  "time:write",
  "members:read",
  "webhooks:manage",
  "audit:read",
  "rules:run",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Scopes a scope stands in for at the contract gate. Writing implies reading
 * what you write to; nothing implies a delete, and nothing implies time, member
 * or audit access. The mask stays the real limit: an implied `read` passes the
 * gate, and the read itself still needs the bits.
 *
 * `items:write` (and `documents:write`, below) implies `planning:write` because keys minted before the split
 * already create, edit and delete milestones and KPIs (they gate on
 * PROJECT_UPDATE, which items:write carries). Passing the gate gives such a key
 * nothing new: its mask still decides, exactly as before. The split still buys
 * least privilege the other way: a `planning:write` key can't edit work items.
 */
const IMPLIES: Partial<Record<ApiKeyScope, ApiKeyScope[]>> = {
  "items:write": ["read", "planning:write"],
  "planning:write": ["read"],
  // documents:write carries PROJECT_UPDATE and ITEM_CREATE, so keys minted
  // with it already reach milestone, KPI and project edits and work-item
  // creation; the same no-loss rule as items:write (the mask still decides).
  // TODO(api): documents:write over-grants (its mask is wider than documents).
  // Narrowing it is a future, announced change (API changelog), never silent.
  "documents:write": ["read", "items:write", "planning:write"],
  "time:write": ["time:read"],
};

/** A token's scopes plus everything they imply. Unknown strings drop out. */
export function effectiveScopes(scopes: readonly string[]): Set<ApiKeyScope> {
  const out = new Set<ApiKeyScope>();
  for (const s of scopes) {
    if (!(API_KEY_SCOPES as readonly string[]).includes(s)) continue;
    out.add(s as ApiKeyScope);
    for (const implied of IMPLIES[s as ApiKeyScope] ?? []) out.add(implied);
  }
  return out;
}

/**
 * Every minimal set of scopes that passes a gate naming `required`, the named
 * set first. The spec lists these as alternative security requirements, so a
 * client reading it sees what the gate actually accepts (an items:write key
 * passes a planning:write operation). Derived from IMPLIES, never kept by hand.
 */
export function satisfyingScopeSets(required: readonly string[]): string[][] {
  if (required.length === 0) return [[]];
  const satisfiers = required.map((r) => API_KEY_SCOPES.filter((s) => effectiveScopes([s]).has(r as ApiKeyScope)));
  let combos: Set<string>[] = [new Set()];
  for (const options of satisfiers) combos = combos.flatMap((c) => options.map((o) => new Set([...c, o])));
  const key = (c: Set<string>) => [...c].sort().join(" ");
  const named = new Set(required);
  const unique = [...new Map(combos.map((c) => [key(c), c])).values()].filter((c) => key(c) !== key(named));
  // Drop any set that strictly contains another: it adds nothing a client needs.
  const minimal = unique.filter((c) => !unique.some((o) => o.size < c.size && [...o].every((x) => c.has(x))));
  minimal.sort((a, b) => a.size - b.size || key(a).localeCompare(key(b)));
  // The contract's own set always comes first, as written, even when a smaller
  // alternative exists (planning:write alone also covers ["read", "planning:write"]).
  return [[...required], ...minimal.map((c) => [...c].sort())];
}
