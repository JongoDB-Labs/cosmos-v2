# Cutover reverse proxy (`cutover-proxy`)

A **separate** Caddy from the app's `compose/Caddyfile`. It sits in front of the **v1 (source)**
and **v2 (target)** stacks during a per-tenant cutover and does two things, both per-org and
both driven live via the Caddy **admin API**:

1. **Routes by orgSlug path prefix** — `/<orgSlug>/…` (the dashboard route shape, see CLAUDE.md).
   Default upstream is **v1** (the source stays live for every org that has not cut over yet).
   After an org flips, a per-org override route points `/<slug>/…` at **v2**.
2. **Per-org write-freeze** — during the brief freeze window a mutating verb
   (`POST`/`PUT`/`PATCH`/`DELETE`) on a frozen org's path returns **HTTP 405** with an
   `Allow: GET, HEAD, OPTIONS` header and a JSON `{"error":"org_frozen",…}` body. **Reads
   (GET/HEAD/OPTIONS) pass through** unaffected. The freeze is enforced **at the proxy** because
   the v1 stack lacks v2's in-app freeze middleware (`src/lib/cutover/freeze.ts`).

## Why at the proxy, and why a full-config `POST /load`

The freeze + flip must happen at the edge: v1 (the live source) has no freeze hook. The control
client (`scripts/cutover/lib/proxy-control.ts`) models the per-org state as
`{ [slug]: { upstream, frozen } }`, **derives the full Caddy route list** from it, and rewrites
the whole config with `POST /load` on every change. `/load` is atomic + zero-downtime and Caddy
auto-rolls-back a bad config. This avoids fragile PATCH-by-array-index surgery and makes every
mutation trivially **idempotent** (re-freezing/re-flipping is a no-op) and the builders pure +
unit-testable (`proxy-control.test.ts`).

## Route order (Caddy is first-terminal-match-wins)

1. `freeze_<slug>` — `(mutating method ∧ /<slug> | /<slug>/*)` ⇒ 405. (Reads don't match.)
2. `upstream_<slug>` — `/<slug>…` ⇒ reverse_proxy → v2 (only for orgs already flipped).
3. `fallback_v1` — catch-all ⇒ reverse_proxy → v1 (every un-flipped org + non-org path).

## Slug-vs-id assumption

The proxy routes by the **path token** at the edge, which for the dashboard is the **orgSlug**.
The API form `/api/v1/orgs/<id>/…` is **not** matched here (it would need an id↔slug map at the
edge); v2's in-app freeze already covers the id-keyed API path inside the app. The cutover window
governs the dashboard slug surface, which is what flips.

## Admin API exposure

- **Prod intent (`caddy.base.json`):** admin listens on `localhost:2019` — **internal only, NOT
  exposed to the host**. The orchestrator drives it from inside the proxy's network namespace
  (e.g. `docker compose exec`, or a control container on the same network).
- **Synthetic acceptance:** the test boots the proxy with a config whose admin binds
  `0.0.0.0:2019` and maps it to a free host port so the host-side orchestrator can drive it. This
  is a TEST-ONLY exposure (see `scripts/cutover/acceptance/run-cutover-acceptance.sh`).

## Boot

```
caddy run --config /etc/caddy/caddy.base.json
```

`caddy.base.json` is generated from the same builder the control client uses (so the booted
config and a `decodeState()` of it agree). Empty state ⇒ everyone on v1, nobody frozen.

> **BUILD-ONLY / SYNTHETIC-TEST ONLY.** Never point the control client at a real production proxy
> without the runbook (`docs/runbooks/cutover.md`) + sign-off.
