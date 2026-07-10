# Runbook: Autonomous delivery (Foreman)

Foreman is the host daemon that works the autonomous-delivery backlog: it takes a
triaged ticket to a merged, versioned, deployed change (**Done**) or a draft PR
(**In Review**). It runs on the host checkout — **not** inside the app image — as
a systemd service, on a connected Claude **subscription** (metered API billing is
structurally refused).

Related: [feedback-remediation.md](feedback-remediation.md) (the triage step that
fills the backlog), [observability.md](observability.md), [backup-dr.md](backup-dr.md).

## The loop

Each pass:

1. **Reconcile** — ship any parked ticket a human has approved (moved to the
   Approved column).
2. **Reclaim** — on startup, move any `in-progress` ticket stranded by a crash/
   restart back to the backlog.
3. **Pick** the next ready backlog ticket from the pooled projects (every project
   any org has enabled autonomous delivery for).
4. **Gate** — dedup (semantic duplicate of a known item?) and clarity (buildable
   without a product decision?). A dup closes; an unclear ticket asks for input.
5. **Implement** — the coding agent runs headless in an isolated worktree
   (`/tmp/foreman/<KEY>`, branch `auto/<KEY>`).
6. **Check** — typecheck + lint(changed) + the full test suite, under
   `NODE_ENV=test` against the e2e database.
7. **Classify & resolve** — small + safe + green → **ship**; risky, oversized, or
   failing → **park** as a draft PR.

## Controls

| Action | Command |
| --- | --- |
| Status | `sudo systemctl status foreman` |
| Live logs | `sudo journalctl -u foreman -f` (also `/var/log/cosmos-foreman.log`) |
| Start | `sudo systemctl start foreman` |
| Stop (graceful) | `sudo systemctl stop foreman` — finishes the current checkpoint, then SIGTERM after 120 s |
| **Emergency stop** | `touch /home/defcon/cosmos-v2/.deploy/FOREMAN_STOP` — the loop exits at its next checkpoint (~1 s) without merging/deploying anything in flight |
| Enable at boot | `sudo systemctl enable foreman` |
| Per-org opt-in | **Settings → Feedback automation → Autonomous delivery** (choose the projects); the daemon idles when no org has it on |

A graceful/kill/breaker stop exits 0 and stays down; only an unexpected crash
exits non-zero, which `Restart=on-failure` brings back (a clean restart reclaims
any stranded ticket). The unit lives at `.deploy/foreman.service` (gitignored,
host-local); `ExecStartPre` clears a stale `FOREMAN_STOP`/`FOREMAN_LOCK` on every
(re)start.

## The audit trail — reworking or rolling back a change

Every resolved ticket gets a **Foreman —** comment carrying the identifiers you
need to act on it:

- **Version** shipped (and, for a shipped change, the exact **rollback target**)
- **PR** link + state, **branch**, **commit** SHA
- **Outcome** + reason, a one-line **change** summary, and — when a build fails
  checks — a **tail of the check output** (so a gate is never undebuggable)

**Rework a parked ticket** (draft PR open):

```bash
git fetch origin && git checkout auto/<KEY>   # the branch named in the comment
# ...fix...
git push
```

Then approve the draft PR (or move the card to **Approved**) — Foreman ships it on
its next pass.

**Roll back a shipped change** — redeploy the prior release named in the comment:

```bash
.deploy/deploy-apponly.sh <rollbackTo>
```

**Rework a shipped change** — branch from the merged commit named in the comment,
change it, and let Foreman ship the next version.

## Safety rails

- **Self-modification gate** (`src/lib/foreman/risk.ts`) — a change that touches
  auth/RBAC/ABAC/AI-egress, `prisma/` schema or migrations, the Dockerfile,
  `next.config.ts`, `.deploy/`, `.github/workflows/`, or Foreman's own code
  (`scripts/foreman/`, `src/lib/foreman/`) is **always** parked for review, never
  auto-shipped. So is any diff over the size budget (> 8 files or > 400 lines).
- **Health-gated deploys** — a deploy that fails the `:8090`/public health check
  rolls back automatically and parks the ticket.
- **Circuit breakers** — repeated deploy or reconcile failures disarm the loop
  rather than thrash.
- **Subscription-only** — the agent's env is allowlisted (`buildAgentEnv` in
  `src/lib/foreman/env.ts`), so metered/cloud-billing vars (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) are
  never forwarded to the child and it can only run on the subscription;
  `assertSubscription` additionally requires a valid subscription login to exist.
- **Isolated, allowlisted agent** — each ticket builds in its own worktree; the
  agent's env is allowlisted (`src/lib/foreman/env.ts`) so it never receives the
  live `DATABASE_URL` or GitHub tokens, and its read-only judges (dedup/clarity)
  run without a shell.

## Troubleshooting

**Every ticket parks on "checks failed."** Read the check-output tail in the
ticket's audit comment. Checks run under `NODE_ENV=test` — the suite fails
wholesale under `NODE_ENV=production` (egress/agent-loop/render tests are written
for test mode), so both the agent's env and the checks env force
`NODE_ENV=test` (`src/lib/foreman/env.ts`). Reproduce a branch's checks locally:

```bash
git worktree add --detach /tmp/diag origin/auto/<KEY>
ln -s "$PWD/node_modules" /tmp/diag/node_modules
cd /tmp/diag && npx tsc --noEmit && DATABASE_URL=<e2e-url> npx vitest run
```

**Daemon won't start / refuses to run.** Confirm a subscription login exists
(`~/.claude/.credentials.json` with a `claudeAiOauth` token), no metered env var
is set, and the e2e database (`:55440`) is up — the checks and the agent's
self-verification both run against it.

**A ticket is stuck `in-progress`.** A crash/kill mid-build leaves it there;
`reclaimStranded` returns it to the backlog on the next start. To force it, move
the card back to Backlog.
