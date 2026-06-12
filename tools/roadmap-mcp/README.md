# COSMOS Roadmap ingest — MCP server

A tiny, dependency-free stdio [MCP](https://modelcontextprotocol.io) server that
lets an MCP-capable LLM client ingest a program roadmap into a COSMOS project.
It wraps the HTTP ingest API (`docs/roadmap/roadmap-ingest.md`) — the model does
the document→schema conversion; this server authenticates and POSTs.

## Tools

- **`roadmap_template`** — returns the import schema, an example, and the LLM
  prompt. Call first to learn the `nodes` shape.
- **`roadmap_ingest`** — `{ mode?: "replace"|"merge", nodes: [...] }` → upserts
  the roadmap into the configured project. Idempotent.

## Setup

The COSMOS API is session-authenticated, so the server needs a logged-in session
cookie (no API-token mechanism yet). Grab the `session=…` cookie from a logged-in
browser session (DevTools → Application → Cookies), then configure your client:

```json
{
  "mcpServers": {
    "cosmos-roadmap": {
      "command": "node",
      "args": ["/abs/path/to/cosmos/tools/roadmap-mcp/server.mjs"],
      "env": {
        "COSMOS_BASE_URL": "https://cosmos.example.com",
        "COSMOS_ORG_ID": "<org-uuid>",
        "COSMOS_PROJECT_ID": "<project-uuid>",
        "COSMOS_COOKIE": "session=<value>"
      }
    }
  }
}
```

Then ask your model: *"Read this roadmap document and ingest it into COSMOS"* —
it will call `roadmap_template`, convert your doc, and call `roadmap_ingest`.

## Notes

- Node 20+ (uses global `fetch`). No `npm install` required.
- Keep program content in your tenant — the server talks only to your COSMOS
  instance.
- Requires `PROJECT_UPDATE` on the target project (the session's user).
