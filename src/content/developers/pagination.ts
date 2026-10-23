import type { Guide } from "./types";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "@/lib/openapi/paginate";

export const guide: Guide = {
  slug: "pagination",
  title: "Pagination",
  summary: "Opt-in cursor pages and the Link header.",
  body: `List operations return a plain JSON array. The next page, when there is one, is announced in headers, GitHub-style:

\`\`\`
Link: <https://cosmos.example.com/api/v1/orgs/…/projects?limit=50&cursor=WyIyMDI2…>; rel="next"
Cosmos-Next-Cursor: WyIyMDI2…
\`\`\`

- **Paging is opt-in.** Send \`limit\` to get pages; send neither \`limit\` nor \`cursor\` and you get the whole list in one response, as clients written before paging expect.
- **\`limit\`**: page size, 1–${MAX_PAGE_LIMIT}. A \`cursor\` without a \`limit\` pages by ${DEFAULT_PAGE_LIMIT}.
- **\`cursor\`**: opaque. Pass back exactly what you were given, with the same other parameters; it only means something to the operation that returned it.
- **Follow \`next\` until it is absent.** No \`Link\` header means the last page; don't infer the end from a page's size.

\`\`\`bash
url="$COSMOS/orgs/$ORG/projects?limit=100"
while [ -n "$url" ]; do
  curl -s -D headers.txt -H "Authorization: Bearer $TOKEN" "$url" | jq -c '.[]'
  url=$(grep -i '^link:' headers.txt | sed -n 's/.*<\\(.*\\)>; rel="next".*/\\1/p')
done
\`\`\`

Pages are keyed on the sort order, not on offsets, so items created while you page don't shift what you've already seen or make you see something twice.
`,
};
