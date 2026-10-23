# openapi/

- `cosmos-v1.json`: the published Cosmos REST API spec (OpenAPI 3.1). **Generated**
  from the `route.contract.ts` files under `src/app/api/v1/`. Edit a contract, then
  run `npm run openapi` and commit the result. CI (`npm run check:openapi`) fails
  when this file is stale, and oasdiff fails a PR that breaks it.
- `cosmos-v1.internal.json`: the whole surface, internal operations included.
  Built by the same command, gitignored, staff only.
- `internal-routes.txt`: v1 operations that have no contract yet. A ratchet that
  only shrinks: delete a line when you convert a route; a new route gets a contract
  (`stability: "internal"` if it isn't public) rather than a line here.

Design: `docs/design/2026-10-23-public-api-and-mcp-design.md` §3.
