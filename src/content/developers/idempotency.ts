import type { Guide } from "./types";

export const guide: Guide = {
  slug: "idempotency",
  title: "Idempotency",
  summary: "Retry a create safely with Idempotency-Key.",
  body: `Network calls fail in ambiguous ways: a timeout doesn't tell you whether the server created the thing. Send an \`Idempotency-Key\` with a \`POST\` that creates something, and a retry with the same key returns the first answer instead of creating it again.

\`\`\`bash
curl -s -X POST "$COSMOS/orgs/$ORG/projects" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"name": "Radar refresh", "key": "RADAR"}'
\`\`\`

- **Use a fresh random key per logical operation**, such as a UUID, and reuse it only for retries of that same operation. Up to 255 printable characters.
- **A replay** is the original status and body, with \`Idempotent-Replayed: true\`.
- **Keys are kept for 24 hours**, per token. The same key from another token is a different key.
- **Same key, different request** (another path or body): \`422\` with code \`idempotency_key_reused\`.
- **Same key while the first request is still running**: \`409\`. Retry after a moment.
- **Only success is remembered.** If the first attempt failed, nothing is kept: fix the request and retry with the same key.

Operations that accept the header say so in the reference. Updates (\`PUT\`/\`PATCH\`) and deletes are naturally idempotent and don't need it.
`,
};
