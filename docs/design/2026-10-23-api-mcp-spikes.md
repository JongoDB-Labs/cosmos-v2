# Spikes: MCP TS SDK v2 and Scalar inside the Cosmos CSP

Date: 2026-10-23. Phase 0, item 3 of `2026-10-23-public-api-and-mcp-design.md`.
Both spikes ran outside the repo (scratch projects); nothing here is a dependency
yet. The packages land with the PRs that use them.

## 1. MCP server: `@modelcontextprotocol/server` v2

**Result: use SDK v2 (2.3.1, Apache-2.0, GA). The v1 fallback isn't needed.**

`createMcpHandler(factory, opts)` returns `{ fetch(request, { authInfo }) }`, a
web-standard `Request → Response` function. A Next route handler is exactly
that, so `src/app/api/mcp/route.ts` stays as thin as the design says:

```ts
const handler = createMcpHandler(buildServer, { legacy: "stateless", responseMode: "json" });
export async function POST(req: Request) {
  // auth, org switch, Origin check, rate limit first (src/lib/mcp/auth.ts) ...
  return handler.fetch(req, { authInfo });
}
```

What was exercised, through a plain `node:http` → `Request` bridge with the
official `@modelcontextprotocol/client`:

| Client mode | Negotiated | `tools/list` | `tools/call` | Factory saw |
|---|---|---|---|---|
| default (2025 handshake) | `2025-11-25` | ok | ok | `era: "legacy"`, `authInfo` passed through |
| `{ pin: "2026-07-28" }` | `2026-07-28` | ok | ok | `era: "modern"` |
| `"auto"` (probe `server/discover`) | `2026-07-28` | ok | ok | `era: "modern"` |

- `GET /api/mcp` → **405** from the handler itself (stateless legacy posture), as the design wants.
- **No `initialize` session state.** The factory runs once per request, which suits a stateless route handler.
- **`fromJsonSchema(def.input_schema)`** registers the assistant's existing JSON Schema
  directly, so the ~70 tools need no zod rewrite. Validation is built in (Ajv, via
  `@modelcontextprotocol/server/validators/ajv`): a call with an extra property and a
  non-uuid `projectId` came back as `isError: true` with
  `data must NOT have additional properties, data/projectId must match format "uuid"`.
  **Design deviation (simplification):** §4.4 step 3's own Ajv pass and the separate `ajv` /
  `ajv-formats` dependencies aren't needed. The MCP copy of each schema still gets
  `additionalProperties: false` and `format: "uuid"` on `*Id` fields; the SDK enforces them.
- `responseMode: "json"` keeps replies as single JSON bodies (no long-running tools). The SDK
  warns that it drops mid-call notifications, which is fine because we emit none.
- The SDK ships `originValidationResponse`, `hostHeaderValidationResponse`,
  `bearerAuthChallengeResponse`, `buildOAuthProtectedResourceMetadata`, `inputRequired`
  (MRTR, for ELICIT mode) and `scopeChallenge` per tool. Phase 4 should use these
  rather than hand-rolling the same headers.
- The entry does **no** token verification (`authInfo` is pass-through), so Cosmos's own
  bearer verification stays the only authority, as designed.

Still to verify in phase 4, against the real app: the same handler inside a
`next dev`/`next build` route with Cache Components on. Nothing in the handler reads
`cookies()`/`headers()`. It takes the `Request` it is given, and a POST route
handler is dynamic.

## 2. Docs renderer: `@scalar/api-reference-react`

**Result: Scalar works under the current CSP with no changes to
`src/lib/security/headers.ts`. Two settings the design didn't list are required.**

Method: bundled `ApiReferenceReact` (0.9.83, MIT) with esbuild, served a stub
spec with the CSP header copied verbatim from `headers.ts`, drove it in
Chromium, and logged every request that left the origin and every console
error.

- Renders the reference, opens the try-it client, sends. **Zero requests left the origin.
  Zero CSP violations.** `style-src 'self' 'unsafe-inline'` already covers the injected
  styles, so the `/developers`-scoped CSP exception the design anticipated **isn't needed**.
- The bundle references `proxy.scalar.com`, `api.scalar.com/request-proxy`,
  `fonts.scalar.com`, `dashboard.scalar.com` and `client.scalar.com`. `connect-src` /
  `font-src 'self'` block them anyway. Configuration also turns them off, so we don't rely
  on the CSP alone.

Configuration for `src/components/developers/api-reference.client.tsx`:

```ts
{
  url: "/api/v1/openapi.json",
  withDefaultFonts: false,      // else fonts.scalar.com
  telemetry: false,             // PostHog: only loads as an explicit plugin, belt and braces
  agent: { disabled: true },    // "Agent Scalar" chat drawer calls Scalar's hosted API
  mcp: { disabled: true },
  persistAuth: false,
  hideClientButton: true,       // DEVIATION: see below
  fetch: (input, init) => fetch(input, { ...init, credentials: "omit" }),  // REQUIRED: see below
  // proxyUrl left unset: same-origin needs no CORS proxy
}
```

**Two findings that change the design:**

1. **Try-it sends the session cookie by default.** With a `session` cookie set, Scalar's
   default `fetch` sent `cookie: session=…` on the try-it request. So the cookie, not the
   pasted token, would have authorized it, which breaks §3.6's rule that "the session cookie
   never authorizes a try-it call". The custom `fetch` above with `credentials: "omit"` was
   re-run against the same page: no cookie header. This line is mandatory, and the phase 2
   e2e asserts it.
2. **`hideClientButton` must be `true`, not `false`.** "Open API Client" is a link to
   `https://client.scalar.com/?url=<our spec URL>`. That hands the instance hostname and spec
   location to a third party and does nothing on an airgapped deploy. The in-page try-it
   (the "Test Request" button) is unaffected.

Size: `@scalar/*` is ~166 MB in `node_modules` and ~5.5 MB minified JS / 275 KB CSS
when bundled. The design already loads it only on `/developers/reference`, so it
must stay behind a dynamic import (`next/dynamic`, `ssr: false`) and never reach the
dashboard bundle.
