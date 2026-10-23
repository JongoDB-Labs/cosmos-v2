import type { Guide } from "./types";
import { API_KEY_SCOPES, API_KEY_SCOPE_LABELS, SCOPE_IMPLICATIONS } from "@/lib/auth/api-key-scopes";

/** Generated from the scope list itself, so the table can't drift from what tokens accept. */
function scopesTable(): string {
  const rows = API_KEY_SCOPES.map((s) => `| \`${s}\` | ${API_KEY_SCOPE_LABELS[s]} |`);
  return ["| Scope | Allows |", "|---|---|", ...rows].join("\n");
}

function implications(): string {
  return Object.entries(SCOPE_IMPLICATIONS)
    .map(([s, implied]) => `\`${s}\` includes ${implied.map((i) => `\`${i}\``).join(" and ")}`)
    .join("; ") + ".";
}

export const guide: Guide = {
  slug: "authentication",
  title: "Authentication",
  summary: "Personal access tokens, organization keys, scopes and what limits a token.",
  body: `Every request authenticates with a bearer token:

\`\`\`
Authorization: Bearer cosmos_<prefix>_<secret>
\`\`\`

There are two kinds of token, and they behave the same on the wire.

| | Personal access token | Organization API key |
|---|---|---|
| Who creates it | Any member, for themselves | An organization admin |
| Where | Settings → Profile → Personal access tokens | Settings → API keys |
| Acts as | You | The admin who minted it |
| Lifetime | Always expires: 30 days by default, at most 90 (30 in a government organization) | Optional expiry |
| Good for | Your own scripts, trying the API | Integrations the organization owns |

The secret is shown once, when the token is created. Cosmos stores only a hash of it. Revoke a token from the same screen; it stops working immediately.

## What a token can do

A token can do what **both** of these allow:

1. **Its scopes.** Every operation in the reference lists the scopes it needs (\`x-cosmos-scopes\`). A token without them gets a \`403\` with code \`insufficient_scope\`.
2. **Its user's permissions, right now.** A token never grants more than the person it acts as. If their role changes, or they leave the organization, the token follows (or stops working).

${scopesTable()}

Some scopes stand in for others: ${implications()} Nothing implies \`items:delete\`, time, member or audit access; ask for those explicitly.

When a token lacks a scope, the \`403\` carries an RFC 6750 challenge naming everything it would need, so a client can ask its user for a better token:

\`\`\`
WWW-Authenticate: Bearer error="insufficient_scope", scope="read items:write"
\`\`\`

## Narrowing a token further

- **Projects.** A token can be limited to some projects. Everything else in the organization is invisible to it, as if it didn't exist (\`404\`).
- **IP allowlist.** If the organization has an IP allowlist, it applies to tokens as well as to browsers.
- **Organization.** A token works in exactly one organization: the one it was created in. \`GET /me\` says which (\`token.orgId\`).

## Things a token can never do

- **Manage tokens.** Listing, creating and revoking personal tokens needs a signed-in browser session. A leaked token can't mint itself a successor.
- **Borrow a session.** A request with a Cosmos bearer is decided by that token alone. If the token is wrong, the request fails with \`401\`, even when the same browser also has a valid session cookie.

## Keeping tokens safe

- Use the smallest scopes that work, a short lifetime, and a project limit when the job allows.
- Keep tokens out of source control and out of URLs. Send them only in the \`Authorization\` header.
- Every request made with a token is attributed to its user in the audit log.
`,
};
