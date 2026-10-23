import type { Guide } from "./types";
import { API_BUDGETS } from "@/lib/rate-limit/api-budget";

function budgets(): string {
  const { read, write } = API_BUDGETS;
  return [
    "| Requests | Sustained | Burst |",
    "|---|---|---|",
    `| Reads (\`GET\`, \`HEAD\`) | ${read.perMinute} a minute | ${read.capacity} |`,
    `| Writes (everything else) | ${write.perMinute} a minute | ${write.capacity} |`,
  ].join("\n");
}

export const guide: Guide = {
  slug: "rate-limits",
  title: "Rate limits",
  summary: "Per-token budgets, the RateLimit headers and handling 429.",
  body: `Each token has its own budget, so one busy integration can't slow down another.

${budgets()}

Every response to a token says where it stands, in the IETF \`RateLimit\` header format:

\`\`\`
RateLimit-Policy: "read";q=600;w=60
RateLimit: "read";r=117;t=1
\`\`\`

\`r\` is what's left right now and \`t\` the seconds until the budget is full again. Over the limit, the answer is \`429\` with code \`rate_limited\` and a \`Retry-After\` header: wait that many seconds before trying again.

Browser sessions aren't charged against these budgets.

## Staying under

- Page with a large \`limit\` instead of many small requests.
- Spread bulk writes out, or use the batch operations where one exists (importing items takes up to 500 per request).
- On \`429\`, honour \`Retry-After\` rather than retrying in a tight loop.
`,
};
