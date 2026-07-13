# ADR 0002 — COSMO Agent connector auth: per-user OAuth vs org-wide credentials

- **Status:** Proposed (design record — the feature is NOT yet implemented)
- **Date:** 2026-07-09
- **Ticket:** COSMOS-18 — "COSMO Agent should be tied to user's oauth/token not org-wide"

## Context

The COSMO Agent (the assistant + the in-channel chat bots, both driven by
`runAgentLoop` in `src/lib/ai/agent-loop.ts`) can act on external systems through a
set of **connectors** (Google Workspace, GitHub, Jira, Slack, Microsoft 365, Nango).
The ticket asks that the agent authenticate to those systems as the **individual
requesting user's** OAuth grant, rather than a **shared org-wide** credential, on
least-privilege grounds. Its acceptance criteria are:

1. The agent authenticates/acts using the requesting user's individual OAuth
   token/credentials rather than a shared org-wide token.
2. Agent actions are limited to the scopes granted to that specific user, and are
   denied when the user lacks access.
3. Actions performed by the agent are attributable to the individual user in audit
   logs.
4. Token lifecycle (refresh, expiry, revocation) is handled per-user without falling
   back to org-wide credentials.

This ADR records what the codebase does **today**, exactly where the gap is, and the
work each connector needs — so the human who picks this up starts from ground truth
rather than re-deriving it. **No behavior is changed by this commit.**

## What is already true today

The picture is mixed, and two of the four criteria are already largely met:

- **Native tools already run as the invoking user (criterion #2, native surface).**
  `runAgentLoop` executes every tool via
  `executeTool(name, input, { orgId, userId, ... })`
  (`src/lib/ai/agent-loop.ts:266`). That path permission-checks against **that user's**
  RBAC/ABAC — the loop's own SECURITY note: "a bot can never do anything the invoking
  user couldn't." So for COSMOS-native data, agent actions are already scoped to the
  caller.

- **Conversation + tool calls are already attributed to the user (criterion #3).**
  The assistant route logs `logAudit({ userId: ctx.userId, action: "chat.message.sent",
  metadata: { toolCallCount } })` and persists the individual `toolCalls` on the
  `AssistantMessage` row (`src/app/api/v1/orgs/[orgId]/assistant/conversations/
  [conversationId]/messages/route.ts:320`). The egress-decision trail
  (`src/lib/ai/egress/audit.ts`) is keyed by `conversationId`, which maps back to one
  user's conversation. (A gap worth noting: egress-decision rows do **not** carry
  `userId` directly — see "Smaller, independently-shippable improvements" below.)

- **Google is already per-user OAuth — the template for this whole ticket.**
  `getGoogleClientForUser(userId)` reads the user's **own** sealed refresh token via
  `getUserCredential("google", userId)` (`src/lib/integrations/google.ts`), stored from
  the OAuth callback by `storeGoogleRefreshToken` → `setCredential(orgId, "google",
  userId, { refreshToken })`. There is no org-wide fallback: a user with no Google grant
  gets a graceful "Google not connected" tool error. This already satisfies criteria
  #1/#2/#4 for the Google connector.

- **The credential store already supports both shapes.** `ConnectorCredential`
  (`src/lib/integrations/credentials.ts`) is vault-sealed (AES-256-GCM) and has BOTH a
  **per-user** row shape (`userId NOT NULL`, read via `getCredential`/`getUserCredential`,
  written via `setCredential`) and an **org-level** row shape (`userId NULL`, read via
  `getOrgCredential`, written via `setOrgCredential`), enforced by two partial unique
  indexes. So the storage substrate for per-user tokens **already exists** — no schema
  change is needed to *store* a per-user token for any provider.

## The gap: four connectors are org-wide by design

These connectors resolve a single **org-shared** credential and have **no** per-user
OAuth path or connect flow:

| Connector | Credential today | Resolver | Grant model |
|-----------|------------------|----------|-------------|
| GitHub    | Org PAT (fine-grained) | `getOrgCredential(orgId, "github")` — `executors/github.ts` | Admin pastes a PAT on the Integrations page |
| Jira      | Org `{ email, apiToken }` | `getOrgCredential(orgId, "jira")` — `executors/jira.ts` | Admin pastes Atlassian email + API token |
| Slack     | Org bot token `{ botToken }` (`xoxb-…`) | `getOrgCredential(orgId, "slack")` — `executors/slack.ts` | Admin pastes a Bot User OAuth token |
| Microsoft 365 | Org Entra **app-only** cred `{ clientId, clientSecret, tenantId }` | `graphFetch(orgId, …)` — `executors/microsoft365.ts` → `integrations/microsoft-graph.ts` | App-only client-credentials grant (org-wide by construction) |

Consequence, and the actual least-privilege concern the ticket raises: **any** user
holding `CHAT_USE` can have the agent read GitHub/Jira/Slack/M365 data through the
shared org credential, even if that user personally has no access to those external
systems. The connector gates (agent policy, runtime-config enablement, tenant-class
gov-block in `src/lib/ai/connectors/registry.ts`) all operate at the **org** level,
not per-user.

## Why this was not auto-implemented in this pass

A faithful implementation is a substantial feature, not a tightly-scoped change, and
it depends on infrastructure that **cannot be provisioned or verified in the autonomous
build environment**:

- **Each org-wide connector needs a genuinely different per-user grant model**, and each
  requires **externally-registered OAuth apps + redirect URIs** plus new consent/callback
  routes:
  - **GitHub** → a GitHub **App (user-to-server)** or OAuth App: per-user authorize +
    callback, encrypted user token + refresh, re-consent on scope change. A PAT (today's
    model) is not per-user.
  - **Microsoft 365** → switch from **app-only** to **delegated** permissions
    (authorization-code + PKCE, per-user refresh token, `/me`-scoped Graph reads). This
    is an architectural change to `microsoft-graph.ts`, not a config toggle.
  - **Jira** → **Atlassian 3LO OAuth** per user (today it's a shared email + API token).
  - **Slack** → per-user **user token** (`xoxp-…`) via OAuth instead of the shared bot
    token, with the narrower per-user scopes.
- **Criterion #4 forbids an org fallback**, so this cannot be shipped as a silent
  "prefer per-user, else org" resolver — that would both change the security posture
  and leave dead code until the connect flows exist.
- The change touches **auth + the ai-egress connector layer** (and adds new routes),
  which is exactly the surface COSMOS gates for **human review** rather than autoship.
- None of the OAuth flows can be exercised end-to-end here (no real OAuth app
  registrations), so an implementation would be unverifiable — i.e. guessing.

Per the COSMOS autonomous-delivery guardrails ("stop and document rather than guess when
the ticket is under-specified or the checks can't be made to pass"), this pass records
the design instead of shipping an untested half-feature.

## Recommended approach (for the human implementer)

Build on the **Google connector as the reference implementation** — it already does
exactly what the ticket asks (per-user sealed token, no org fallback, graceful
"not connected") and the `ConnectorCredential` per-user row + `getCredential`/
`setCredential` primitives are ready to reuse.

**Phase 1 — one connector, end-to-end, as the pattern.** Pick **GitHub** (read-only,
smallest blast radius). Register a GitHub App/OAuth App; add per-user
`/integrations/github/connect` + callback routes that `setCredential(orgId, "github",
userId, …)`; change `resolveGitHubAccess` (`executors/github.ts`) to read
`getCredential(orgId, "github", userId)` (or a user-scoped read) with **no** org
fallback — a missing per-user grant returns the existing graceful "not connected"
error. Add a per-user "connected?" indicator (mirror `hasUserCredential`).

**Phase 2 — token lifecycle (criterion #4).** Per-user refresh-before-expiry using the
`meta` (non-secret expiry hints) already supported by `setCredential`; treat a
revoked/expired grant as "not connected" (never fall back to an org token); wipe the
per-user row on disconnect (mirror `deleteOrgCredential`, but per-user).

**Phase 3 — remaining connectors.** Apply the same shape to Jira (Atlassian 3LO),
Slack (user token), and Microsoft 365 (delegated auth-code + PKCE, `/me`-scoped Graph).
M365 is the largest lift (app-only → delegated).

**Cross-cutting:**
- **Egress is unchanged.** Per-user grants change *whose* data flows in; the egress gate
  (`src/lib/ai/egress`) still governs *what the model sees* under the MAC ceiling.
  Preserve every gov-block/tenant-class rule in `connectors/registry.ts` exactly.
- **Attribution (criterion #3).** Consider threading `userId` into the egress-decision
  row so the connector audit trail names the acting user directly (see below).
- **Migration.** Decide the fate of existing org-shared creds: keep them for
  admin/service use, or deprecate per-connector. Criterion #4 means the agent path must
  not fall back to them.

## Smaller, independently-shippable improvements (not blocked on OAuth infra)

If a reviewer wants incremental value before the full feature lands, each of these is a
self-contained, testable change that advances a criterion without external infra — but
each still touches the gated auth/ai-egress surface, so it belongs behind human review:

- **Per-user attribution on connector actions (criterion #3).** Add `userId` to the
  egress-decision row / a dedicated connector-action audit entry so external actions are
  attributable to the individual user directly, not only via `conversationId`.
- **Per-user authorization gate on org-wide connectors (criterion #2, partial).** Before
  the agent dispatches an org-shared connector tool, require the invoking user to hold a
  connector-use permission — denying + auditing when they don't. This narrows the "any
  `CHAT_USE` user can reach org GitHub/Jira/Slack/M365" exposure even while the token
  stays org-wide. (Requires choosing/defining the permission — a design decision.)

## References

- Agent loop (runs tools as the invoking user) — `src/lib/ai/agent-loop.ts`
- Credential store (per-user + org-level, vault-sealed) — `src/lib/integrations/credentials.ts`
- Reference per-user connector (Google) — `src/lib/integrations/google.ts`
- Org-wide connectors — `src/lib/ai/executors/{github,jira,slack,microsoft365}.ts`
- Microsoft Graph (app-only client-credentials) — `src/lib/integrations/microsoft-graph.ts`
- Connector registry + gov-block/enablement gates — `src/lib/ai/connectors/registry.ts`
- Assistant route (audit attribution) — `src/app/api/v1/orgs/[orgId]/assistant/conversations/[conversationId]/messages/route.ts`
