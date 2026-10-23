import type { Guide } from "./types";
import { PROBLEM_CODES, type ProblemCode } from "@/lib/openapi/problem-codes";

/**
 * What each code means to a client. Typed against PROBLEM_CODES, so a new code
 * fails to compile until it is documented here. Each renders as a heading: the
 * problem `type` (/developers/guides/errors#<code>) links to it.
 */
const MEANING: Record<ProblemCode, { status: string; text: string }> = {
  invalid_request: { status: "400", text: "The request is malformed or fails validation, such as a known parameter with an invalid value; see `issues`. Query parameters an operation doesn't know are ignored." },
  unauthorized: { status: "401", text: "No credential, or one that isn't valid: unknown, revoked, expired, or from outside the organization's IP allowlist." },
  forbidden: { status: "403", text: "The token's user lacks a permission this needs." },
  insufficient_scope: { status: "403", text: "The token lacks a scope this operation needs. `WWW-Authenticate` names the scopes to ask for." },
  not_found: { status: "404", text: "It doesn't exist, or this caller can't see it. Cosmos doesn't tell the two apart." },
  conflict: { status: "409", text: "It conflicts with the current state: a duplicate, a stale update, or the same `Idempotency-Key` still in flight." },
  model_not_connected: { status: "409", text: "The operation needs Claude, and this organization hasn't connected it. An admin can connect it in Settings → AI / Model." },
  rate_limited: { status: "429", text: "This token is over its budget. Wait `Retry-After` seconds." },
  idempotency_key_reused: { status: "422", text: "This `Idempotency-Key` was already used for a different request." },
  unsupported_api_version: { status: "400, 410", text: "`Cosmos-API-Version` names a version that never existed (400) or has been retired (410)." },
  internal_error: { status: "500", text: "Something failed on our side. The body never includes internal details; quote `requestId`." },
};

function codes(): string {
  return (Object.keys(PROBLEM_CODES) as ProblemCode[])
    .map((c) => `### ${c}\n\n**${MEANING[c].status}** · ${PROBLEM_CODES[c]}. ${MEANING[c].text}`)
    .join("\n\n");
}

export const guide: Guide = {
  slug: "errors",
  title: "Errors",
  summary: "Problem documents, error codes, request ids and when to retry.",
  body: `Every error is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem document, served as \`application/problem+json\`:

\`\`\`json
{
  "type": "/developers/guides/errors#not_found",
  "title": "Not found",
  "status": 404,
  "detail": "Project not found",
  "code": "not_found",
  "requestId": "4c0a6a0e-5d1f-4b8e-9f43-0a7d6b1c2e11",
  "error": "Project not found"
}
\`\`\`

- **Branch on \`code\`**, not on \`detail\`. Codes are stable; wording isn't.
- **\`requestId\`** is the request's \`X-Request-Id\` (every response carries the header). Quote it when you contact support. Send your own \`X-Request-Id\` (up to 128 of \`A–Z a–z 0–9 . _ : -\`) and Cosmos uses it instead of minting one.
- **\`issues\`** appears on \`400\` validation errors: one entry per field that failed, with its \`path\` and a \`message\`.
- **\`error\`** repeats \`detail\` (or \`title\`). It exists for clients written before problem documents; new code should read \`code\` and \`detail\`.

## Codes

${codes()}

## Retrying

Retry \`429\` after \`Retry-After\` seconds, and \`5xx\` with exponential backoff. Retry a \`POST\` only with an [\`Idempotency-Key\`](/developers/guides/idempotency), so a retry can't create something twice. Don't retry other \`4xx\` errors unchanged: they will fail the same way.
`,
};
