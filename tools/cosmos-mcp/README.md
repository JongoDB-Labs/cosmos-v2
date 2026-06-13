# COSMOS BYO-LLM ingest — MCP server

A tiny, dependency-free stdio [MCP](https://modelcontextprotocol.io) server that
lets an MCP-capable LLM client ingest structured items and documents into a
COSMOS project. It wraps the bearer-authed HTTP ingest API
(`docs/byollm/ingest-api.md`) — the model does the document→schema conversion;
this server authenticates with your API key and calls the endpoints.

## Tools

- **`cosmos_template`** — returns the item-import schema (per type), a worked
  example, and an LLM prompt. Call first to learn the `items[]` shape.
- **`items_ingest`** — `{ mode?: "create", items: [...] }` → creates one row per
  item (ISSUE / MILESTONE / OBJECTIVE / GOAL / CYCLE / ROADMAP_NODE).
- **`document_ingest`** — `{ filename, contentType, dataBase64, title? }` →
  uploads a file from base64 bytes; COSMOS stores, parses, and persists its block
  tree.
- **`document_list`** — lists the documents already ingested into the project.
- **`document_get`** — `{ docId }` → one document plus its parsed blocks (use the
  block ids for `blocks_convert`).
- **`blocks_convert`** — `{ docId, blockId, itemType, title? }` → converts one
  parsed block into a project item (with a source link back to the document).

## Setup

Mint an org-scoped API key in COSMOS (**Settings → API keys**); choose the scopes
you need (`read`, `items:write`, `documents:write`). The plaintext key
(`cosmos_…`) is shown once — copy it. The key acts as the minting user, and its
effective permissions are that user's permissions intersected with the chosen
scopes. Bearer requests bypass CSRF, so no cookie or Origin header is needed.

Then configure your client:

```json
{
  "mcpServers": {
    "cosmos": {
      "command": "node",
      "args": ["/abs/path/to/cosmos/tools/cosmos-mcp/server.mjs"],
      "env": {
        "COSMOS_BASE_URL": "https://cosmos.example.com",
        "COSMOS_ORG_ID": "<org-uuid>",
        "COSMOS_PROJECT_ID": "<project-uuid>",
        "COSMOS_API_KEY": "cosmos_<prefix>_<secret>"
      }
    }
  }
}
```

Then ask your model: *"Read this planning doc and ingest its tasks into COSMOS"* —
it will call `cosmos_template`, convert your doc, and call `items_ingest`; or
`document_ingest` → `document_get` → `blocks_convert` to bring a file in and turn
its blocks into items.

## Notes

- Node 20+ (uses global `fetch`). No `npm install` required.
- Keep program content in your tenant — the server talks only to your COSMOS
  instance.
- For any example or demo, use the **Apex Defense Systems demo** project — never
  paste real or CUI project data into prompts or configs.
- Requires a key whose scopes cover what you call: `read` for templates/listing,
  `items:write` to create items, `documents:write` to upload documents.
