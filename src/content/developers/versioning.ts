import type { Guide } from "./types";
import { API_VERSION } from "@/lib/openapi/version";

export const guide: Guide = {
  slug: "versioning",
  title: "Versioning",
  summary: "Date versions, what counts as breaking, and the deprecation policy.",
  body: `The API has date versions. The current one is **${API_VERSION}**.

## Choosing a version

Send \`Cosmos-API-Version: YYYY-MM-DD\` to run a request at a particular version; the response echoes it. Without the header:

- a **token** runs at the version that was current when it was created, so an integration never changes behaviour under you;
- a **browser session** runs at the current version.

An unknown version is a \`400\` and a retired one a \`410\`, both with code \`unsupported_api_version\`.

## What changes when

- **Additive changes ship any time, in every version:** new operations, new optional parameters, new fields in responses, new error codes. Write clients that ignore fields they don't know.
- **Breaking changes ship only in a new version:** removing or renaming a field or operation, making a parameter required, changing a type or a default.
- **A superseded version stays supported for at least 12 months.** Responses at a deprecated version carry \`Deprecation\` and \`Sunset\` headers and a \`Link\` to its changelog entry. After the sunset date it answers \`410\`.

Every change is in the [API changelog](/developers/changelog), also as an [RSS feed](/developers/changelog/rss.xml).

## Stability

Each operation is marked in the reference:

- **stable**: covered by the policy above.
- **beta**: may change without a new version, with notice in the changelog.

Routes that aren't in the reference at all are internal to the web app. They can change at any time; don't build on them.
`,
};
