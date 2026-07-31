# Cosmos

A multi-tenant **project- and program-management platform**: boards (Kanban,
Scrum, Backlog, Roadmap, Release Timeline, Gantt), OKRs, dependency mapping,
RAID logs, SAFe program increments, document ingestion, an agentic in-app AI
assistant, and a feedback portal that turns product feedback into shipped
software — all org-scoped with role- and attribute-based access control.

Built on **Next.js 16** (App Router, **Cache Components** on), **React 19**,
**Prisma 7 / PostgreSQL** (with pgvector), and `@base-ui/react`. Sentence
embeddings run **in-process and fully offline** (MiniLM via onnxruntime), so the
app never phones home for AI retrieval. The running version is surfaced in the
sidebar from `package.json`.

> **Contributors:** read [`AGENTS.md`](AGENTS.md) before writing code. This
> codebase follows conventions that differ from stock Next.js (Cache Components,
> org-scoped query keys, `TEXT` permission masks, `@base-ui/react` primitives) —
> they are load-bearing, and TypeScript won't catch violations of most of them.

---

## Table of contents

- [What Cosmos does](#what-cosmos-does) — the feature surface for end users
- [Feedback → backlog → delivery, automatically](#feedback--backlog--delivery-automatically) — the autonomous-delivery flagship
- [Roles & access](#roles--access)
- [Administration](#administration) — the settings & admin surfaces
- [Architecture](#architecture) — platform situational awareness
- [Development](#development) — local setup, commands, plugins, testing
- [Build & deploy](#build--deploy)
- [Documentation](#documentation) — ADRs & runbooks

---

## What Cosmos does

Everything is scoped to an **organization** (tenant). Which modules an org sees
is gated by its entitlements, so not every org exposes every surface below.

**Work management**
- **Projects** — each with its own tabbed workspace of boards and views.
- **Work items / issues** — comments, activity history, watchers, links &
  dependencies, duplicates, bulk edit, custom item types and fields, and an
  org-wide issue list across projects.
- **Boards** — created from a built-in catalog and a template gallery with
  industry presets: **Kanban** (WIP limits, swimlanes), **Scrum** (sprint board
  with burndown + velocity), **Backlog** (prioritized, story points), **Table**,
  **Timeline / Gantt** (interactive scheduler, dependencies, critical path),
  **Release Timeline**, **Roadmap** (strategic epic swimlanes), **Calendar**,
  **OKR**, **Portfolio** (cross-project status grid), **Dashboard** (custom
  widgets), **RAID Log** (Risks, Actions, Issues, Decisions), **Cumulative Flow
  (CFD)**, and **Program Board (SAFe)** (PI-planning grid, team swimlanes). A
  drag-and-drop **board builder** rounds it out.

**Planning & delivery**
- **Intervals** — timeboxes with planning, capacity, and completion. Kinds
  include **Sprints**, **Iterations**, and **SAFe Program Increments** (a
  planning interval that parents sprints).
- **Milestones**, **Roadmap** (hierarchical, deep-linkable nodes), and a
  **Dependency map**.
- **OKRs** (objectives, key results, check-ins), **Goals & KPIs** (with data
  points), and **Time tracking** (entries with submit / approve / bulk-approve).

**Program-management suite**
- A per-project **PM Dashboard** with registers — Overview, Risk Register,
  Change Log, Blocked Items, Schedule, Deliverables, Vendors, Staffing, and
  CLIN burn — plus earned-value metrics and Excel export, and an org-level
  portfolio roll-up.

**Documents & ingestion**
- Per-project **files**: upload documents, convert them, and **AI-propose work
  items from a document**. A separate **CSV / Excel import wizard** brings in
  existing backlogs.

**CRM & finance** *(entitlement-gated modules)*
- **CRM** — contacts, partners, products, contracts (PDF + e-signature), and a
  sales pipeline.
- **Finance & accounting** — expenses, revenue, chart of accounts, journal
  entries, standard reports (trial balance / P&L / balance sheet), banking
  (reconciliation, rules, import/match), payroll, and tax.

**Collaboration**
- **Chat** (channels, DMs, threads, reactions, pins, mentions, presence,
  attachments, slash-commands), **Meetings** (attendees, video, AI transcript
  summaries), **Notes** (entity mentions & backlinks), an **activity feed**,
  and **notifications** (in-app + web push).

**Analytics & reports**
- Portfolio / project / sprint / interval / feedback analytics and saved
  reports.

**Cosmo — the AI assistant**
- A floating, **agentic** assistant that answers questions *and takes actions*
  through a large tool catalog: create / update / query work items, projects,
  intervals, notes, OKRs, goals, boards, documents, CRM records, meetings,
  compliance controls, PM registers, and finance/accounting entities, plus
  **semantic search** and external connectors (Google Workspace, Microsoft 365,
  GitHub, Jira, Slack). Supports voice dictation and a **"Hey Cosmo" wake word**.
- A **⌘K command palette** provides fast navigation and search.

**Feedback portal**
- In-app **bug reports and feature requests** with upvoting and a status
  workflow (`OPEN → PLANNED → IN_PROGRESS → IN_REVIEW → DONE / DECLINED`). Each
  item records its reporter — which is carried onto any work item it becomes,
  and (optionally) all the way to a shipped change. That's the front end of the
  automation below.

---

## Feedback → backlog → delivery, automatically

Cosmos turns product feedback into shipped software with as much or as little
automation as each org opts into. Configure it under **Settings → Feedback
automation**.

1. **Capture.** Users file feature requests and bug reports in the in-app
   feedback portal. Each item records who reported it — that reporter is shown on
   the item and carried onto any work item it becomes.
2. **Auto-triage.** On a connected Claude subscription, new feedback is
   classified (type, severity, effort, acceptance criteria) and delivered into
   the target project's backlog — hourly, so nothing sits in the inbox. Pick one
   or more target projects, plus a default for anything unrouted.
3. **Autonomous delivery (opt-in, owner-level).** A host daemon ("Foreman") works
   the backlog of the projects you enable: for each ticket it implements the
   change on an isolated branch, runs the full checks (typecheck, lint, tests),
   repairs a failing build in-session (bounded rounds), has an adversarial
   read-only reviewer agent judge the final diff, and then either
   - **ships it** — opens a PR, auto-merges, tags a SemVer release, builds the
     signed image, deploys, and health-gates — for small, safe changes; or
   - **parks it for review** — as a draft PR — for anything risky (touches
     auth/RBAC, the schema, CI, the Dockerfile, or Foreman's own code), oversized,
     or failing checks.

   Every ticket gets an **audit trail** comment recording the outcome, version,
   PR, branch, commit, and — for a shipped change — the exact command to roll it
   back. Autonomous delivery runs only on a connected Claude **subscription**
   (never metered API billing) and is gated behind an org toggle and a kill
   switch. See [`docs/runbooks/autonomous-delivery.md`](docs/runbooks/autonomous-delivery.md).

**Board choreography.** Foreman works the board left to right: Backlog (open
pool) → To-do (planned up next) → In progress → Review (parked for you) →
Done (shipped). Move a ticket back to To-do or Backlog to have it reworked —
comments ride along. To-do is curated by Foreman itself — a planner pass
promotes the highest-priority/ROI backlog tickets (votes, severity, age) and
posts a "Planned" event with the reasoning.

**Observability & supervision.** Every org with autonomous delivery gets a
dedicated `/[org]/foreman` console: live pulse (alive/idle/stale/paused/circuit-
breaker), what's building right now, tickets parked awaiting a decision, and a
full decision-feed audit trail. A compact pulse card on the org dashboard
mirrors the same at-a-glance status and links straight through. Pause and
resume the daemon from either surface — in-flight work always finishes first,
nothing is discarded. A host-side systemd timer watches the daemon's heartbeat
and, if it goes quiet, POSTs to `/api/foreman/alert` (bearer-authenticated via
the `FOREMAN_ALERT_TOKEN` env var) so a stuck or crashed daemon doesn't fail
silently.

A parked ticket stays conversational: comment "approve" (or "lgtm" / "ship
it") and Foreman marks its draft PR ready and merges it — deploy follows on
the next reconcile pass, and no @Foreman mention is needed since a comment on
a parked ticket is already talking to it. Any other comment resumes the exact
same agent session against the same branch and PR instead of starting over;
comment "rebuild" to discard that attempt and build fresh instead. The
console's parked cards carry matching one-click **Approve** and **Rebuild**
buttons, with Approve disabled until there's a PR to merge.

The difference between auto-triage and autonomous delivery is only where a ticket
lands: triage puts it in the backlog; delivery takes it to **Done** (a merged,
versioned, deployed change) or **In Review** (a draft PR).

Foreman is itself a **fail-closed plugin**, composed in from a separate private
repository (see [Architecture](#architecture)); the public core carries only the
neutral integration hooks, and it stays dormant until it's composed in and an
owner opts in.

---

## Roles & access

Every org is seeded with eight built-in work roles — Project Manager,
Contributor, Reviewer/Approver, Operations Coordinator, Finance Manager,
Analyst, Client/Stakeholder, and Compliance Officer — covering common project
responsibilities out of the box, on top of the six base org roles (Owner, Admin,
Billing admin, Member, Viewer, Guest) that every member already has. **Settings →
Roles & Access** shows the exact permissions behind every one of them, base and
built-in alike, and any role can be **cloned** into a new custom role and
tailored from there. Built-in roles are read-only server-side, so the defaults
can't drift or be edited out from under you. Per-member assignment also
lives on the Team page, via each row's **Manage roles** dialog.

Access is enforced by a combined **RBAC + ABAC** model: role-derived permission
masks plus an attribute-based policy engine for finer, context-dependent
decisions (scope, branch, data classification).

---

## Administration

Org owners and admins configure the workspace under **Settings**. Every surface
is permission-gated; the groups below mirror the in-app navigation.

**Organization**
- **Organization** — identity, branding, and themes.
- **Roles & Access** — RBAC roles, work roles, and member management (see above).

**AI & integrations**
- **AI / Model** — connect a Claude subscription or model-provider credentials.
- **Agent Policy** — what the AI agent is permitted to do (capability guardrails).
- **Agent Governance** — egress-audit and agent control posture.
- **MCP Servers** — register Model Context Protocol servers so Cosmo can call
  their tools.
- **Runtime Config** — connector enablement, breadth, and tenant class.
- **Plugins** — enable/disable optional capability bundles for the org (the
  fail-closed plugin system; see [Architecture](#architecture)).
- **Feedback Automation** — the auto-triage and autonomous-delivery controls
  described [above](#feedback--backlog--delivery-automatically).
- **Integrations**, **Webhooks** (outbound event subscriptions with delivery
  logs and test), and **API Keys** (bearer tokens for the Cosmos API).

**Workspace & data**
- **Templates** — built-in and custom project templates.
- **Custom Fields** — per-entity field schemas.
- **Classifications** — data-classification labels.

**Security & compliance**
- **Security** — single sign-on (OIDC/SAML), session management, IP allowlists,
  and SCIM tokens.
- **Compliance** — frameworks, controls, and posture.
- **Audit Logs** — org activity history, with export.

**Platform administration** *(instance-wide, not org-scoped)*
- A separate `/admin` surface, restricted to platform operators (the
  `INTERNAL_ADMINS` allowlist), configures the instance **sign-in allowlist** and
  **sign-in providers** (OAuth apps for Google / Microsoft, with credentials
  stored vault-sealed — never in env files).

---

## Architecture

### Tech stack

| Area | Choice |
|---|---|
| Framework | Next.js 16 (App Router, `output: standalone`, **Cache Components** / PPR on) |
| UI | React 19, `@base-ui/react`, Tailwind CSS v4, lucide-react, recharts, lexical, dnd-kit |
| Data | Prisma 7 with the `@prisma/adapter-pg` driver adapter, PostgreSQL + **pgvector** |
| Embeddings | `Xenova/all-MiniLM-L6-v2` (384-dim) in-process via `@huggingface/transformers` (onnxruntime), **offline** — the model is baked into the image and never fetched at runtime |
| AI | `@anthropic-ai/sdk`; the delivery agent uses the Claude Agent SDK |
| Validation | zod v4 |
| Observability | OpenTelemetry traces + metrics over **OTLP** (`@vercel/otel`) — observe-only, non-blocking, no PII |

### Multi-tenant model — "one source, many products"

One codebase, one deployable; per-org differentiation lives in **data,
templates, sector-scoped behavior, and gated modules** rather than forks (see
[`docs/adr/0001-one-source-many-products.md`](docs/adr/0001-one-source-many-products.md)).
Module gating via org entitlements is **fail-open** (a missing entitlement row
means all modules are on). Product branding is a **build-time** selector
(`PRODUCT` build-arg → `NEXT_PUBLIC_PRODUCT`, default `cosmos`).

### Plugin system — fail-closed capability bundles

Documented in [`docs/adr/0003-plugin-system.md`](docs/adr/0003-plugin-system.md).
Optional capabilities are packaged as plugins that are **fail-closed**: with no
per-org enablement row (or `enabled=false`), a plugin is **off**. This is the
deliberate opposite of the fail-open module entitlements — adding a plugin to the
codebase changes nothing for any running org until it opts in. Effective
visibility is `RBAC(user) ∩ entitlements(org) ∩ pluginEnablement(org)`.

- **Registry** — a client-safe manifest (slug, version, sectors, contributed
  modules/nav, typed config fields — **no secrets**) plus server-only hooks
  (config schema, first-enable/upgrade lifecycle, AI tools, integration
  providers).
- **Isolation** — plugin code lives under `src/plugins/<slug>/**` and may import
  shared code, but shared code imports back only through sanctioned seams and
  thin route shims. Plugins own **additive, `<Slug>`-prefixed Prisma models**.
  These invariants are enforced by **architecture tests** plus an ESLint mirror.

**Public core / private plugins.** This public repo ships the **neutral core**:
`src/plugins/` does not exist here, and the two composition seams register **zero
plugins** — the core "compiles and runs clean with an empty registry
(fail-closed)." Private client/vertical plugins live in separate repositories and
are **composed in at build time**, overlaying their code into the tree without
ever being committed to the public core. See
[Working with plugins](#working-with-plugins) for the tooling.

### Autonomous delivery (Foreman)

A **host daemon** (a systemd service on the deploy host, *not* code inside the
app image) that carries a triaged backlog from ticket → merged, versioned,
deployed change — or parks it as a draft PR. It implements each ticket in an
isolated worktree via the Claude Agent SDK, runs typecheck + lint + the full
test suite with bounded repair rounds, submits the diff to an **adversarial
read-only reviewer** (fail-closed on an unreadable verdict), and classifies the
result. Safety rails: a **self-modification risk gate** always parks changes
touching auth/RBAC/ABAC, AI egress, the schema/migrations, the Dockerfile, CI,
`.deploy/`, or Foreman's own code (and any oversized diff); deploys are
**health-gated with auto-rollback**; and the agent is **subscription-only**
(metered API keys are structurally refused) and never receives `DATABASE_URL` or
Git tokens. Foreman is itself a fail-closed plugin. Full design in
[`docs/runbooks/autonomous-delivery.md`](docs/runbooks/autonomous-delivery.md).

### Security & observability posture

The platform targets a **gov/regulated, offline-capable** deployment: offline
in-process embeddings, in-boundary OTLP telemetry that emits only
counts/enums/hashes/latency (never CUI/PII), vault-sealed per-tenant SSO secrets,
a single arch-test-enforced AI-egress path, a non-root minimal container, and a
supply chain with an SBOM, cosign signatures, SLSA provenance, and SHA-pinned
workflow actions. Many runbooks are NIST 800-171 control-mapped.

---

## Development

### Prerequisites

- **Node.js 24** (used by CI and the Docker images; not pinned in-repo).
- **PostgreSQL with the `pgvector` and `pgcrypto` extensions** — a vanilla
  Postgres image will fail the extension/vector migrations. The
  `pgvector/pgvector:pg16` image is what CI uses.
- **npm** (the repo uses `package-lock.json`).
- **Docker** — only needed for the full `docker-compose` stack or the container
  acceptance suites; not required to run `npm run dev` against a local Postgres.

### First-time setup

```bash
# 1. Install dependencies (also runs husky via the prepare script)
npm install

# 2. Create env files from the template, then fill in values. For this
#    non-Docker local flow, set DATABASE_URL and DIRECT_URL to the localhost
#    form (the template defaults to the docker-compose hostname):
#      postgres://cosmos:cosmos@localhost:5432/cosmos
#    Two loaders read two files: the Prisma CLI/Migrate reads `.env`, and the
#    seed scripts read `.env.local` — keep the value in both.
cp .env.example .env
cp .env.example .env.local

# 3. Start a Postgres that has pgvector + pgcrypto
docker run -d --name cosmos-pg -p 5432:5432 \
  -e POSTGRES_USER=cosmos -e POSTGRES_PASSWORD=cosmos -e POSTGRES_DB=cosmos \
  pgvector/pgvector:pg16
#   -> DATABASE_URL=postgres://cosmos:cosmos@localhost:5432/cosmos (set DIRECT_URL the same)

# 4. Create the DB login roles the migrations GRANT to (required on a fresh DB)
npx prisma db execute --file prisma/sql/ci-roles.sql

# 5. Generate the Prisma client, then apply all migrations
npx prisma generate
npx prisma migrate deploy

# 6. Seed. Deterministic fixtures (what CI/e2e use):
npx tsx prisma/seed/test-fixtures.ts
#   or the general seed:  npm run seed        (demo data: npm run seed:demo)

# 7. Run the app
npm run dev        # http://localhost:3000
```

**Minimum env vars** (see [`.env.example`](.env.example) for the full set and
the feature-gated extras — object storage, web push, SSO vault, Anthropic, etc.):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (hard requirement everywhere). |
| `DIRECT_URL` | Set equal to `DATABASE_URL` (no connection pooler is used). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google OAuth sign-in. |
| `ALLOWED_EMAILS` | Comma-separated sign-in allowlist — your account must be listed. |

**Signing in locally** — use Google OAuth (with the vars above), or run
`node scripts/create-dev-session.mjs` to mint a dev session as the first org's
owner and set it on the `session` cookie. Never generate real secret values;
follow `.env.example`'s notes (e.g. `openssl rand -base64 32`).

### Everyday commands

```bash
npm run dev                                          # Turbopack dev server
NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit   # typecheck (OOMs at the 2GB default)
npm run lint                                          # eslint
npm test                                              # vitest run
npm run test:arch                                     # architecture-invariant tests
npm run e2e:install && npm run e2e                    # Playwright e2e (needs the dev server)
npm run build                                         # next build (standalone)
```

> There is **no `npm run typecheck`** script — use `npx tsc --noEmit` with the
> raised heap limit shown above (this is what CI runs).

### Testing

Most unit specs **mock Prisma** and run hermetically; a handful of
DB-integration specs need a live, migrated, seeded Postgres and a `DATABASE_URL`
(CI provisions one before `npm test`). Tests run under `NODE_ENV=test` (vitest's
default) — the suite is not designed to pass under `NODE_ENV=production`. The
Docker acceptance suites are separate and driven by their own configs.

### Working with plugins

The public core builds and runs with **zero plugins**. To compose private
plugins into a checkout, clone each into `plugins/<slug>/` (each carries a
`plugin.json` manifest), then:

```bash
node scripts/plugins/sync.mjs        # overlay plugin code + schema + registries
npx prisma generate && npm run dev   # (the script prints these next steps)

node scripts/plugins/sync.mjs --clean   # reverse the composition
```

`sync.mjs` overlays each plugin's `overlay/**`, appends its Prisma schema
fragment, injects back-relations, and regenerates the registry seams — while
keeping composed content **out of git** (via `.git/info/exclude` and
`skip-worktree`) so it can never be staged or committed to the public core. It
refuses to overlay a path that collides with a tracked core file.

---

## Build & deploy

The app ships as a **signed** multi-arch container image published to
`ghcr.io/jongodb-labs/cosmos-v2` (plus companion `-migrate` and `-postgres`
images). Releases are cut by pushing a `vX.Y.Z` SemVer tag, which triggers the
release workflow to:

- build each architecture (amd64 / arm64) natively and push **by digest**, then
  assemble a multi-arch manifest;
- generate a **Syft SPDX SBOM**;
- **sign** every image with cosign — keyless via GitHub OIDC (public
  Fulcio/Rekor) **always**, plus an optional KMS/HSM key when configured — and
  attach a **SLSA build-provenance** attestation; a verify-after-sign gate fails
  the release if any published tag lacks a verifiable signature, so a
  green-but-unsigned release is impossible. The Helm chart is signed and
  provenance-attested the same way.

**Deploy is separate and health-gated.** The release workflow builds and signs;
it does not deploy. Deployment happens out-of-band (see the autonomous-delivery
runbook), pulling the published digest and health-gating it with automatic
rollback on failure. **Secrets are runtime-only** and never baked into a layer —
treat the image filesystem as world-readable (only `APP_VERSION` and `PRODUCT`
are baked); see [`AGENTS.md`](AGENTS.md).

---

## Documentation

- **Architecture Decision Records** — [`docs/adr/`](docs/adr/): one source /
  many products (0001), agent connector auth (0002), the plugin system (0003).
- **Runbooks** — [`docs/runbooks/`](docs/runbooks/): autonomous delivery, audit
  integrity, backup & disaster recovery, per-tenant cutover, feedback
  auto-remediation, observability, public hostname & TLS, and secret rotation.
  Many are NIST 800-171 control-mapped.
- **Contributor conventions** — [`AGENTS.md`](AGENTS.md). Read it first.

---

## License

Licensed under the **GNU Affero General Public License v3.0** — see
[LICENSE](LICENSE) for the full text.

AGPL-3.0 is a network copyleft license: if you modify this software and make it
available to users over a network, you must also offer those users the
corresponding source. For alternative licensing terms, open an issue to start a
conversation.
