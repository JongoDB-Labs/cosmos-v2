/**
 * The public API's changelog: what changed for API clients, newest first.
 * Rendered at /developers/changelog (and its RSS feed) and in llms.txt.
 *
 * CI (scripts/openapi/check.mjs) requires an entry in any change that alters
 * openapi/cosmos-v1.json. A breaking change also needs `breaking: true`, a new
 * date version in lib/openapi/version.ts, and the `api-breaking` PR label.
 * The product changelog (src/lib/changelog.ts) is separate and ops' to edit.
 */
export interface ApiChangelogEntry {
  /** ISO date the change shipped. Also the anchor: /developers/changelog#<date>. */
  date: string;
  title: string;
  /** Markdown. */
  body: string;
  breaking?: boolean;
}

export const API_CHANGELOG: ApiChangelogEntry[] = [
  {
    date: "2026-11-01",
    title: "Cosmos API v1 is documented",
    body: [
      "The REST API under `/api/v1` now has a published OpenAPI 3.1 description (`/api/v1/openapi.json`) and reference.",
      "",
      "- **Errors** are RFC 9457 `application/problem+json`. The old `error` string is still there.",
      "- **Every response** carries `X-Request-Id`.",
      "- **Lists** can be paged on request: send `limit` and follow the `Link` header. Without it you get the whole list, as before.",
      "- **Tokens:** personal access tokens (`/me/tokens`) and finer scopes (`items:delete`, `planning:write`, `time:read`/`time:write`, `members:read`, `webhooks:manage`, `audit:read`), enforced per operation with a `403 insufficient_scope` step-up.",
      "- **Rate limits** per token, with `RateLimit` headers and `Retry-After`.",
      "- **`Idempotency-Key`** on create operations.",
      "- **Versioning:** `Cosmos-API-Version`, currently `2026-11-01`.",
      "",
      "Behaviour changes for existing keys: listing members needs `members:read`, and member email addresses are no longer returned to tokens.",
    ].join("\n"),
  },
];
