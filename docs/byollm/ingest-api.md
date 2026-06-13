# BYO-LLM ingest — HTTP API

Bring your own LLM. An external agent (or any HTTP client) authenticates with a
COSMOS API key and ingests structured items and documents straight into a
project. The model does the document→schema conversion; COSMOS authenticates,
validates, and creates the rows.

There are two ways in: this plain **HTTP API**, and an **MCP server** that points
an MCP-capable LLM client straight at these endpoints
(`tools/cosmos-mcp/README.md`). Both hit the exact same routes.

> All examples below use the **Apex Defense Systems demo** project. Never paste
> real or CUI project data into example commands, prompts, or logs.

## Mint an API key

**Settings → API keys → Create** in COSMOS. Pick the scopes the agent needs:

| Scope              | Grants                                                            |
| ------------------ | ---------------------------------------------------------------- |
| `read`             | read projects, items, OKRs, sprints (templates + listing)        |
| `items:write`      | create items (issues, milestones, OKRs, goals, sprints, roadmap) |
| `documents:write`  | upload documents and convert their blocks into items             |

The plaintext key is shown **once** as `cosmos_<prefix>_<secret>` — copy it
immediately. Only its hash is stored.

### Auth model

- **Org-scoped.** A key belongs to one organization; pass that org's id in the
  URL.
- **Acts as the minting user.** The key carries no identity of its own — every
  created row is attributed to the user who minted it.
- **Permissions ∩ scopes.** Effective permissions at request time are the minting
  user's current permissions *intersected* with the key's scope mask, so a key
  can never grant more than its user has, nor more than its scopes allow.
- **No CSRF.** Bearer requests bypass CSRF — no `Origin` header or CSRF token is
  required. Send the key as `Authorization: Bearer cosmos_<prefix>_<secret>`.

Responses are bare JSON objects (not wrapped in `{ "data": … }`).

Set up shell variables for the examples:

```bash
BASE="https://cosmos.example.com"
ORG="<org-uuid>"
PROJECT="<project-uuid>"     # the Apex Defense Systems demo project
KEY="cosmos_<prefix>_<secret>"
API="$BASE/api/v1/orgs/$ORG/projects/$PROJECT"
AUTH="Authorization: Bearer $KEY"
```

## Items

### GET `items/import` — template (scope: `read`)

Returns the per-type schema, a worked example, and a ready-to-paste LLM prompt.
Fetch this first so your model emits a conformant `items[]` array.

```bash
curl -s -H "$AUTH" "$API/items/import"
```

### POST `items/import` — ingest items (scope: `items:write`)

Body `{ "mode"?: "create", "items": [ … ] }`. `items` is a flat array (1–500);
each item is tagged with its `type` and carries that type's fields. One row is
created per item, attributed to the key's minting user. `mode` is `create` (the
only mode today).

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "mode": "create",
    "items": [
      { "type": "ISSUE", "title": "Wire up SSO callback", "priority": "HIGH" },
      { "type": "MILESTONE", "title": "Beta launch", "dueDate": "2026-09-01" }
    ]
  }' \
  "$API/items/import"
```

The response is a report: `{ mode, created: [{ type, id, title, ticketNumber? }],
roadmap?, warnings }`.

#### Item fields by type

Every item needs a `title` — **except** `CYCLE`, which uses `name`. All other
fields are optional; omit any you can't fill (don't invent data).

**`ISSUE`** — a task / ticket (work item).

| Field         | Type / values                                   | Default               |
| ------------- | ----------------------------------------------- | --------------------- |
| `title`       | string (required)                               | —                     |
| `description` | markdown                                         | empty                 |
| `columnKey`   | board column key                                 | first column          |
| `priority`    | `CRITICAL` \| `HIGH` \| `MEDIUM` \| `LOW`        | `MEDIUM`              |
| `tags`        | string[]                                          | `[]`                  |
| `dueDate`     | ISO date                                          | none                  |
| `startDate`   | ISO date                                          | none                  |

**`MILESTONE`** — a dated checkpoint.

| Field         | Type / values        | Default                |
| ------------- | -------------------- | ---------------------- |
| `title`       | string (required)    | —                      |
| `description` | markdown              | none                   |
| `dueDate`     | ISO date              | +30 days from now      |

**`OBJECTIVE`** — an OKR objective.

| Field         | Type / values                                                | Default   |
| ------------- | ------------------------------------------------------------ | --------- |
| `title`       | string (required)                                            | —         |
| `description` | markdown                                                      | none      |
| `period`      | string, e.g. `Q3 2026`                                        | none      |
| `status`      | `DRAFT` \| `ACTIVE` \| `COMPLETED` \| `CANCELLED`            | `ACTIVE`  |

**`GOAL`** — a delivery goal.

| Field          | Type / values                                                       | Default   |
| -------------- | ------------------------------------------------------------------- | --------- |
| `title`        | string (required)                                                   | —         |
| `description`  | markdown                                                            | none      |
| `status`       | `PLANNED` \| `ON_TRACK` \| `AT_RISK` \| `OFF_TRACK` \| `ACHIEVED`   | `PLANNED` |
| `targetDate`   | ISO date                                                            | none      |
| `progressMode` | `MANUAL` \| `AUTO`                                                  | `MANUAL`  |

**`CYCLE`** — a sprint / phase. Uses `name`, not `title`.

| Field       | Type / values                                                                          | Default            |
| ----------- | -------------------------------------------------------------------------------------- | ------------------ |
| `name`      | string (required)                                                                      | —                  |
| `goal`      | string                                                                                 | empty              |
| `startDate` | ISO date                                                                               | now                |
| `endDate`   | ISO date                                                                               | +14 days from now  |
| `cycleKind` | `SPRINT` \| `PHASE` \| `MODULE` \| `RUN` \| `EVENT_DAY` \| `RELEASE` \| `ITERATION`     | `SPRINT`           |

**`ROADMAP_NODE`** — a program-roadmap node (sections, phases, LOEs, risks,
decisions, stakeholders, milestones). All `ROADMAP_NODE` items in one request are
upserted together (merge), so cross-references resolve.

| Field         | Type / values                                                                     | Default       |
| ------------- | --------------------------------------------------------------------------------- | ------------- |
| `kind`        | `SECTION` \| `SUBPHASE` \| `LOE` \| `RISK` \| `DECISION` \| `STAKEHOLDER` \| `MILESTONE` (required) | — |
| `title`       | string (required)                                                                 | —             |
| `externalRef` | stable id, e.g. `R-19` / `P-1` (unique per project)                               | none          |
| `section`     | section number / label                                                            | none          |
| `category`    | grouping band                                                                     | none          |
| `body`        | markdown — the ACTUAL content                                                     | none          |
| `parentRef`   | `externalRef` / anchor of the parent node (nests it)                              | none          |
| `sortOrder`   | number                                                                            | array order   |
| `meta`        | object of structured extras                                                       | none          |

## Documents

### POST `documents` — upload from base64 (scope: `documents:write`)

Send `Content-Type: application/json` with `{ filename, contentType, dataBase64,
title? }`. The `filename` extension drives format detection; the bytes are the
base64-encoded file. COSMOS stores it, parses it, and persists its block tree
(max 25 MB). The browser path uses multipart `file`; API-key clients use this
JSON shape.

```bash
DATA=$(base64 -w0 ./apex-plan.pdf)
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "{
    \"filename\": \"apex-plan.pdf\",
    \"contentType\": \"application/pdf\",
    \"title\": \"Apex Defense — Q3 Plan\",
    \"dataBase64\": \"$DATA\"
  }" \
  "$API/documents"
```

Returns the created document (`201`) with its `id`.

### GET `documents` — list (scope: `read`)

```bash
curl -s -H "$AUTH" "$API/documents"
```

Returns documents (id, title, filename, format, status, …), most recent first.

### GET `documents/{docId}` — one document + blocks (scope: `read`)

```bash
curl -s -H "$AUTH" "$API/documents/$DOC_ID"
```

Returns the document plus its parsed `blocks` (ordered by `ordinal`). Use a
block's `id` as `blockId` when converting.

### POST `documents/{docId}/convert` — block → item (scope: `documents:write`)

Body `{ blockId, itemType, title? }`. Converts one parsed block into a project
item (and a source link back to the document). `itemType` is one of `ISSUE` |
`MILESTONE` | `OBJECTIVE` | `GOAL` | `CYCLE` | `ROADMAP_NODE` (default `ISSUE`);
`title` overrides the block-derived title.

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "blockId": "<block-uuid>",
    "itemType": "ISSUE",
    "title": "Implement radar telemetry ingest"
  }' \
  "$API/documents/$DOC_ID/convert"
```

Returns the created item (`201`).

## See also

- `tools/cosmos-mcp/README.md` — the MCP server wrapping these same endpoints.
- `docs/roadmap/roadmap-ingest.md` — the roadmap-only ingest contract (a subset of
  `ROADMAP_NODE` ingest).
