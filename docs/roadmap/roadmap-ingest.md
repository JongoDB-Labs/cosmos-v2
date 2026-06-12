# Roadmap ingest — bring your own roadmap

The **Roadmap** project feature renders your program roadmap (sections, phases,
lines-of-effort, risks, decisions, stakeholders, milestones) as navigable,
deep-linkable nodes that issue descriptions can cite as source-of-truth. You 
bring your own roadmap by having the **LLM of your choice** convert your roadmap
document into our import format and posting it — no manual data entry.

There are two ways in: a plain **HTTP API** and an **MCP server** (point an LLM
client straight at it). Both write the same `RoadmapNode` schema.

## Enable the feature

Project Settings → Features → **Roadmap** (or set `enabledFeatures` to include
`"roadmap"`). The tab appears in the project nav.

## The import contract

`POST /api/v1/orgs/{orgId}/projects/{projectId}/roadmap-nodes/import`

```jsonc
{
  "mode": "replace",            // "replace" (default) wipes + reinstalls; "merge" upserts
  "nodes": [
    {
      "kind": "SECTION",         // SECTION | SUBPHASE | LOE | RISK | DECISION | STAKEHOLDER | MILESTONE
      "title": "§1. Program Overview",   // required
      "externalRef": "S-1",      // stable id + deep-link key, unique per project (optional)
      "section": "1",            // grouping label (optional)
      "category": "Schedule",    // register band, e.g. for risks/decisions (optional)
      "body": "Markdown — the ACTUAL content, not just an id (optional)",
      "parentRef": "S-1",        // externalRef/anchor of the parent — nests the node (optional)
      "sortOrder": 0,            // optional; defaults to array order
      "meta": { }                // structured extras: likelihood/impact/owner/date… (optional)
    }
  ]
}
```

Only `kind` and `title` are required. Anchors (URL slugs), ids, and ordering are
derived server-side, so an LLM never has to invent them. Re-posting is idempotent
(nodes are keyed by `externalRef`/anchor). Requires `PROJECT_UPDATE`.

`GET …/roadmap-nodes/import` returns this schema, a worked **example**, and a
ready-to-paste **`llmPrompt`** — fetch it and hand it to your model.

## Workflow (LLM of your choice)

1. `GET …/roadmap-nodes/import` → copy the `llmPrompt` + `example`.
2. Give your LLM that prompt **plus your roadmap document** (paste, attach, or
   point your agent at it). Ask for the `{ "mode": "replace", "nodes": [...] }`
   JSON only.
3. `POST` the returned JSON to `…/roadmap-nodes/import`.
4. Open the **Roadmap** tab. Link issues to nodes by typing `#` in a work-item
   description (a roadmap-node picker) or by pasting a node deep-link
   `/{org}/projects/{KEY}/roadmap/{anchor}`.

> **Keep program content in your tenant.** The ingest writes straight to your
> database; nothing roadmap-related is sent to any external service by COSMOS.
> If your content is sensitive, run the conversion with a model you trust.

## MCP server

A thin stdio MCP server wraps the ingest API so an LLM client (e.g. Claude
Desktop) can ingest directly. See `tools/roadmap-mcp/README.md`.

## Demo data

The **Apex Defense Systems** demo org ships a mock CMMC/RMF roadmap as a product
walkthrough. It is clearly labeled (a "Demo / walkthrough data" banner) and fully
removable: `npm run seed:demo:teardown` (preview with `--dry-run`). Recreate with
`npm run seed:demo`.
