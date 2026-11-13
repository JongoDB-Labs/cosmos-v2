/**
 * Client-safe API-key scope vocabulary — PURE constants, no server-only imports
 * (no prisma/crypto/session), so a client component (the Settings panel) can import
 * it without dragging the server auth graph into the browser bundle. The server lib
 * (`api-key.ts`) and the routes import these from here too.
 *
 * A scope does two things. It is a CEILING on the key's permissions (the bit
 * mask below, intersected with the minting user's own), and it is a GATE on the
 * public API: every operation's contract names the scopes a token must hold
 * (`x-cosmos-scopes` in the spec). The mask decides what the user could do; the
 * scope decides what this token was minted to do.
 *
 * The mask lives here rather than in api-key.ts so the Settings page can say,
 * from the very same table, which scopes a person can put on a key
 * (api-key-policy.ts). Permission bits are not secret; they are the same
 * constants every role card in Settings already ships to the browser.
 */
import { Permission } from "@/lib/rbac/permissions";

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

const SCOPE_MASK: Record<ApiKeyScope, bigint> = {
  // COMMENT_READ belongs in `read` for the same reason the others do: a
  // conversation is part of reading an item, and without it a key could POST a
  // comment (with items:write) and then be denied its own reply on the way back
  // out — "Access denied by policy" on a GET the caller had just written to.
  //
  // Deliberately NOT ORG_READ or ANALYTICS_READ. The mask is recomputed from a
  // key's scopes on every request, so a bit added here reaches every existing
  // read key on every route, including writes that gate on ORG_READ alone
  // (scope-compat.test.ts checks that no bit here gates a write). The reads that
  // need ORG_READ ask a key for PROJECT_READ instead (labels, custom fields),
  // and its creator for ORG_READ: keyMay in rbac/key-role.ts.
  read:
    Permission.PROJECT_READ | Permission.ITEM_READ | Permission.COMMENT_READ |
    Permission.OKR_READ | Permission.SPRINT_READ,
  // Write means write: CREATE alone let a key file an item and then never touch
  // it again — no status change, no re-assign, no comment — which is most of
  // what "work the board without a browser" actually is. ITEM_UPDATE and
  // COMMENT_CREATE are what the item PUT and the comment POST gate on.
  //
  // ITEM_DELETE is deliberately NOT here. Destroying work is a different
  // decision from editing it, and a scope named for writing should not quietly
  // carry it; a key that needs to delete should say so with a scope of its own.
  "items:write":
    Permission.PROJECT_READ | Permission.PROJECT_UPDATE | Permission.ITEM_READ |
    Permission.ITEM_CREATE | Permission.ITEM_UPDATE |
    Permission.COMMENT_CREATE | Permission.COMMENT_READ |
    Permission.OKR_READ | Permission.OKR_CREATE |
    Permission.SPRINT_READ | Permission.SPRINT_CREATE,
  // The delete half of items:write, as its own decision: work items and OKRs.
  // A planning delete (milestone, goal, KPI) needs planning:write as well.
  "items:delete": Permission.ITEM_DELETE | Permission.OKR_DELETE,
  // Milestones, goals, KPIs and interval changes, split out of items:write so a
  // reporting integration can plan without being able to edit work.
  "planning:write":
    Permission.PROJECT_READ | Permission.PROJECT_UPDATE | Permission.ITEM_READ |
    Permission.OKR_READ | Permission.OKR_CREATE | Permission.OKR_UPDATE |
    Permission.SPRINT_READ | Permission.SPRINT_CREATE | Permission.SPRINT_UPDATE,
  // Time is its own domain: hours are payroll and billing data, not work items.
  // Rates stay behind canSeeRate (own rows, or FINANCE_READ) whatever the scope.
  "time:read": Permission.TIME_READ,
  "time:write": Permission.TIME_READ | Permission.TIME_CREATE | Permission.TIME_UPDATE,
  // A disclosure scope, not a permission: it adds no bits. A token sees
  // members' email addresses (member list, project members) only when it holds
  // it, because integrations match people by email and the key's owner should
  // opt into handing a script everyone's address. Contracts name the fields
  // (`scopedFields`); respond() removes them for tokens without it.
  "members:read": 0n,
  "webhooks:manage": Permission.WEBHOOK_MANAGE,
  "audit:read": Permission.AUDIT_LOG_READ,
  "documents:write":
    Permission.PROJECT_READ | Permission.PROJECT_UPDATE | Permission.ITEM_READ | Permission.ITEM_CREATE,
  // Exactly one permission, and deliberately no read: a scheduler needs to
  // TRIGGER rules, not to browse the org. Anything wider would hand a key that
  // sits on a cron box the ability to read projects.
  "rules:run": Permission.RULES_RUN,
};

/** OR together the bit-masks for the given scope names; unknown scopes contribute
 *  nothing (0n) so an untrusted scope string can never widen the grant. */
export function scopeMask(scopes: string[]): bigint {
  return scopes.reduce((m, s) => m | (SCOPE_MASK[s as ApiKeyScope] ?? 0n), 0n);
}

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
