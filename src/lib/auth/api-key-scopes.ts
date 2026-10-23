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

/** How Settings names each scope, next to its code. */
export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  read: "Read",
  "items:write": "Write items",
  "items:delete": "Delete items",
  "planning:write": "Write plans (milestones, goals, KPIs, intervals)",
  "documents:write": "Write documents",
  "time:read": "Read time",
  "time:write": "Log time",
  "members:read": "Read members",
  "webhooks:manage": "Manage webhooks",
  "audit:read": "Read the audit log",
  "rules:run": "Run checks",
};

/**
 * Scopes a scope stands in for at the contract gate. Writing implies reading
 * what you write to; nothing implies a delete, and nothing implies time, member
 * or audit access. The mask stays the real limit: an implied `read` passes the
 * gate, and the read itself still needs the bits.
 */
export const SCOPE_IMPLICATIONS: Partial<Record<ApiKeyScope, ApiKeyScope[]>> = {
  "items:write": ["read"],
  "planning:write": ["read"],
  "documents:write": ["read"],
  "time:write": ["time:read"],
};

/** A token's scopes plus everything they imply. Unknown strings drop out. */
export function effectiveScopes(scopes: readonly string[]): Set<ApiKeyScope> {
  const out = new Set<ApiKeyScope>();
  for (const s of scopes) {
    if (!(API_KEY_SCOPES as readonly string[]).includes(s)) continue;
    out.add(s as ApiKeyScope);
    for (const implied of SCOPE_IMPLICATIONS[s as ApiKeyScope] ?? []) out.add(implied);
  }
  return out;
}
