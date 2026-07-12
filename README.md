# Cosmos

A multi-tenant project- and program-management platform: boards (Kanban, Scrum,
Backlog, Roadmap, Release Timeline, Gantt), OKRs, dependency mapping, RAID logs,
SAFe program increments, document ingestion, and an in-app feedback portal — all
org-scoped with role- and attribute-based access control.

Built on Next.js 16 (App Router, **Cache Components** on), Prisma 7 / PostgreSQL,
and `@base-ui/react`. The running version is surfaced in the sidebar from
`package.json` — see [`AGENTS.md`](AGENTS.md) for the conventions this codebase
follows (they differ from stock Next.js; read it before contributing).

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

**Observability & supervision.** Every org with autonomous delivery gets a
dedicated `/[org]/foreman` console: live pulse (alive/idle/stale/paused/circuit-
breaker), what's building right now, tickets parked awaiting a human decision
(with one-click requeue), and a full decision-feed audit trail. A compact pulse
card on the org dashboard mirrors the same at-a-glance status and links straight
through. Pause and resume the daemon from either surface — in-flight work always
finishes first, nothing is discarded. A host-side systemd timer watches the
daemon's heartbeat and, if it goes quiet, POSTs to `/api/foreman/alert` (bearer-
authenticated via the `FOREMAN_ALERT_TOKEN` env var) so a stuck or crashed
daemon doesn't fail silently.

The difference between auto-triage and autonomous delivery is only where a ticket
lands: triage puts it in the backlog; delivery takes it to **Done** (a merged,
versioned, deployed change) or **In Review** (a draft PR).

## Roles & access

Every org is seeded with eight built-in work roles — Project Manager,
Contributor, Reviewer/Approver, Operations Coordinator, Finance Manager,
Analyst, Client/Stakeholder, and Compliance Officer — covering common project
responsibilities out of the box, on top of the six base org roles (Owner, Admin,
Billing admin, Member, Viewer, Guest) that every member already has. **Settings →
Roles & Access** shows the exact permissions behind every one of them, base and
built-in alike, and any role can be **cloned** into a new custom role and
tailored from there. Built-in roles are read-only server-side, so the defaults
can't drift or be edited out from under you.

## Development

```bash
npm install
npm run dev        # Turbopack dev server
npm run typecheck  # tsc --noEmit
npm run lint
npm test           # vitest (against a seeded e2e database)
```

Tests run under `NODE_ENV=test` against a local e2e Postgres — the suite is not
designed to pass under `NODE_ENV=production`.

## Build & deploy

The app ships as a signed container image published to
`ghcr.io/jongodb-labs/cosmos-v2`. Releases are cut by pushing a `vX.Y.Z` tag,
which triggers the release workflow to build and sign the image; the host then
pulls and health-gates it. Treat the image filesystem as world-readable — secrets
are runtime-only and never baked into a layer (see `AGENTS.md`).
