import type { Guide } from "./types";

export const guide: Guide = {
  slug: "quickstart",
  title: "Quickstart",
  summary: "Make your first request with curl, TypeScript or Python.",
  body: `The Cosmos REST API lives under \`/api/v1\` on your Cosmos instance. Everything the web app does goes through it, and the operations in the [reference](/developers/reference) are the ones we document and keep stable.

## 1. Get a token

Open **Settings → Profile → Personal access tokens** in the organization you want to work in, choose **New token**, give it a name and the scopes it needs (start with \`read\`), and copy the secret. It is shown once:

\`\`\`
cosmos_3f9a1c2b7d4e_Zm9vYmFyYmF6…
\`\`\`

Send it as a bearer token on every request. A token acts as you, in one organization, and can never do more than you can (see [Authentication](/developers/guides/authentication)).

## 2. Who am I?

\`\`\`bash
export COSMOS=https://cosmos.example.com/api/v1
export TOKEN=cosmos_...

curl -s -H "Authorization: Bearer $TOKEN" $COSMOS/me
\`\`\`

\`\`\`json
{ "id": "0b6d…", "email": "you@example.com", "displayName": "You", "token": { "orgId": "6f1e…", "scopes": ["read"], "kind": "PERSONAL", "expiresAt": "…" }, … }
\`\`\`

\`token.orgId\` is the organization this token works in. Most operations take it in the path.

## 3. List projects

\`\`\`bash
ORG=6f1e...   # token.orgId from /me
curl -s -H "Authorization: Bearer $TOKEN" "$COSMOS/orgs/$ORG/projects?limit=20"
\`\`\`

Lists are JSON arrays. When there is another page, the response has a \`Link: <…>; rel="next"\` header; follow it until it's gone ([Pagination](/developers/guides/pagination)).

## The same in TypeScript

\`\`\`ts
const base = "https://cosmos.example.com/api/v1";
const headers = { Authorization: \`Bearer \${process.env.COSMOS_TOKEN}\` };

const me = await fetch(\`\${base}/me\`, { headers }).then((r) => r.json());
const res = await fetch(\`\${base}/orgs/\${me.token.orgId}/projects?limit=20\`, { headers });
if (!res.ok) throw new Error((await res.json()).detail);
const projects = await res.json();
\`\`\`

Typed clients: generate types from the spec with [\`openapi-typescript\`](https://openapi-ts.dev) (\`npx openapi-typescript https://cosmos.example.com/api/v1/openapi.json -o cosmos.d.ts\`) and call through \`openapi-fetch\`.

## And in Python

\`\`\`python
import os, requests

base = "https://cosmos.example.com/api/v1"
s = requests.Session()
s.headers["Authorization"] = f"Bearer {os.environ['COSMOS_TOKEN']}"

me = s.get(f"{base}/me").json()
r = s.get(f"{base}/orgs/{me['token']['orgId']}/projects", params={"limit": 20})
r.raise_for_status()
for p in r.json():
    print(p["key"], p["name"])
\`\`\`

## Next

- [Errors](/developers/guides/errors): every failure is \`application/problem+json\` with a \`code\` you can branch on.
- [Rate limits](/developers/guides/rate-limits) and [Idempotency](/developers/guides/idempotency) before you write anything that retries.
- The full [OpenAPI description](/api/v1/openapi.json), for code generators and API tools.
`,
};
