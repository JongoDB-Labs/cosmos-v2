// Every org route handler an API key can authenticate to that checks NO
// permission bit, and what it does with a key.
//
// A key's reach is its scope mask ∩ its minter's permissions, and the mask is
// only ever consulted by a bit check. A handler that checks none admits a key
// of ANY scope: a `rules:run` key, or a `read` key, acting as its minter. Now
// that members mint their own keys, that is a person's whole self-service
// surface in a script's hands. So each such handler says what it does with a
// key, here, and bitless-routes.arch.test.ts holds the code to it:
//
//   - "refused":  the route is for a person in a browser. It calls
//                 refuseApiKey(ctx) (lib/auth/key-gate.ts) right after
//                 authenticating, before it reads or writes anything.
//   - "scope":    a key may use it when it holds these scopes. It calls
//                 requireKeyScopes(ctx, [...]) — the same gate a contracted
//                 route's `x-cosmos-scopes` runs (assertScopes).
//   - "any":      a key of any scope may use it, and why that is safe.
//   - "sibling":  handled by another change in flight; listed so the guard
//                 sees it, and so it fails once that change lands (the entry
//                 is then stale and must go).
//   - "helper":   gated through a helper the scanner doesn't follow. The guard
//                 checks the handler really calls it (passing `bit`, when
//                 named) and that the helper really calls a gate with it.
//   - "bit":      for a key only, the handler demands this bit, the power the
//                 key would have needed to create what it now acts on.
//
// Keys are `METHOD route` with the route relative to src/app/api, the shape
// read-mask-writes.test.ts uses.
import type { ApiKeyScope } from "@/lib/auth/api-key-scopes";
import type { PermissionKey } from "@/lib/rbac/permissions";

export type KeyAccess =
  | { key: "refused" }
  | { key: "scope"; scopes: ApiKeyScope[] }
  | { key: "any"; why: string }
  | { key: "sibling"; why: string }
  | { key: "helper"; helper: string; bit?: PermissionKey }
  | { key: "bit"; bit: "PROJECT_UPDATE"; why: string };

export const BITLESS_ROUTES: Record<string, KeyAccess> = {
  // ── A person's own Outlook connection. `?invites=cancel` on DELETE cancels
  //    their meeting invitations and emails every attendee.
  "GET v1/orgs/[orgId]/microsoft/calendar": { key: "refused" },
  "DELETE v1/orgs/[orgId]/microsoft/calendar": { key: "refused" },
  "GET v1/orgs/[orgId]/microsoft/calendar/connect": { key: "refused" },
  "POST v1/orgs/[orgId]/microsoft/calendar/sync": { key: "refused" },

  // ── A person's own UI preferences, including Do Not Disturb.
  "GET v1/orgs/[orgId]/preferences": { key: "refused" },
  "PUT v1/orgs/[orgId]/preferences": { key: "refused" },

  // ── Calendar feed links: creating or changing one already refused keys.
  "GET v1/orgs/[orgId]/calendar-feeds": { key: "refused" },
  "POST v1/orgs/[orgId]/calendar-feeds": { key: "refused" },
  "PATCH v1/orgs/[orgId]/calendar-feeds/[feedId]": { key: "refused" },
  "DELETE v1/orgs/[orgId]/calendar-feeds/[feedId]": {
    key: "any",
    why: "Revoking a link only ever narrows what is exposed: a leaked feed URL should be revocable from wherever its owner holds a credential (calendar-feeds/key-gate.test.ts).",
  },

  // ── Feedback attachments: the uploader's delete needs no bit. Keys can't
  //    read or file feedback at all (ORG_READ is in no scope).
  "DELETE v1/orgs/[orgId]/feedback/attachments/[attachmentId]": { key: "refused" },

  // ── Creating, listing and revoking API keys is for a person: a leaked key
  //    must never mint its own successor or revoke the others.
  "GET v1/orgs/[orgId]/api-keys": { key: "refused" },
  "POST v1/orgs/[orgId]/api-keys": { key: "refused" },
  "DELETE v1/orgs/[orgId]/api-keys/[keyId]": { key: "refused" },

  // ── Read-only org facts a script may reasonably want.
  "GET v1/orgs/[orgId]/logo": { key: "scope", scopes: ["read"] },
  "GET v1/orgs/[orgId]/query-language": { key: "scope", scopes: ["read"] },

  // ── Gated on a bit through a local or library helper the scan can't read.
  "GET v1/orgs/[orgId]/bank-rules": { key: "helper", helper: "authorize", bit: "FINANCE_READ" },
  "POST v1/orgs/[orgId]/bank-rules": { key: "helper", helper: "authorize", bit: "FINANCE_MANAGE" },
  "GET v1/orgs/[orgId]/invoices/[invoiceId]": { key: "helper", helper: "gate", bit: "FINANCE_READ" },
  "PUT v1/orgs/[orgId]/invoices/[invoiceId]": { key: "helper", helper: "gate", bit: "FINANCE_MANAGE" },
  "DELETE v1/orgs/[orgId]/invoices/[invoiceId]": { key: "helper", helper: "gate", bit: "FINANCE_MANAGE" },
  "GET v1/orgs/[orgId]/employees/[employeeId]/supervisors": { key: "helper", helper: "requireEmployeeAdmin" },
  "PUT v1/orgs/[orgId]/employees/[employeeId]/supervisors": { key: "helper", helper: "requireEmployeeAdmin" },
  "POST v1/orgs/[orgId]/employees/bulk": { key: "helper", helper: "requireEmployeeAdmin" },

  // ── Chat reads and the org event stream: being gated in a sibling change
  //    (chat reads on CHAT_USE, which no scope grants; the stream by project).
  "GET v1/orgs/[orgId]/chat/attachments/[attachmentId]": { key: "sibling", why: "chat reads" },
  "GET v1/orgs/[orgId]/chat/bots": { key: "sibling", why: "chat reads" },
  "GET v1/orgs/[orgId]/chat/channels": { key: "sibling", why: "chat reads" },
  "GET v1/orgs/[orgId]/chat/channels/[channelId]": { key: "sibling", why: "chat reads" },
  "PATCH v1/orgs/[orgId]/chat/channels/[channelId]": { key: "sibling", why: "chat channel admin, decided by channel role" },
  "DELETE v1/orgs/[orgId]/chat/channels/[channelId]": { key: "sibling", why: "chat channel admin, decided by channel role" },
  "GET v1/orgs/[orgId]/chat/channels/[channelId]/members": { key: "sibling", why: "chat reads" },
  "POST v1/orgs/[orgId]/chat/channels/[channelId]/members": { key: "sibling", why: "chat channel admin, decided by channel role" },
  "DELETE v1/orgs/[orgId]/chat/channels/[channelId]/members/[userId]": { key: "sibling", why: "chat channel admin, decided by channel role" },
  "GET v1/orgs/[orgId]/chat/channels/[channelId]/messages": { key: "sibling", why: "chat reads" },
  "GET v1/orgs/[orgId]/chat/channels/[channelId]/messages/[messageId]/replies": { key: "sibling", why: "chat reads" },
  "GET v1/orgs/[orgId]/chat/channels/[channelId]/pins": { key: "sibling", why: "chat reads" },
  "GET v1/orgs/[orgId]/chat/channels/[channelId]/read-state": { key: "sibling", why: "chat reads" },
  "GET v1/orgs/[orgId]/chat/channels/browse": { key: "sibling", why: "chat reads" },
  "GET v1/orgs/[orgId]/chat/presence": { key: "sibling", why: "chat reads" },
  "GET v1/orgs/[orgId]/chat/search": { key: "sibling", why: "chat reads" },
  "GET v1/orgs/[orgId]/events": { key: "sibling", why: "the org event stream" },
};

/**
 * Handlers that DO check a bit, but only on some paths, so the scanner can't
 * see that another path checks none: the author of a feedback item edits or
 * deletes it with no bit. Listed by hand from the audit; the table-driven
 * route test drives each.
 */
export const BRANCH_BITLESS_ROUTES: Record<string, KeyAccess> = {
  "PUT v1/orgs/[orgId]/feedback/[feedbackId]": { key: "refused" },
  "DELETE v1/orgs/[orgId]/feedback/[feedbackId]": { key: "refused" },
  "DELETE v1/orgs/[orgId]/projects/[projectId]/documents/[docId]": {
    key: "bit",
    bit: "PROJECT_UPDATE",
    why: "The uploader withdraws their own file with no bit. A key may when it could have uploaded it (PROJECT_UPDATE: items:write, planning:write or documents:write); anyone else's file still needs items:delete (canManageDocument).",
  },
};
