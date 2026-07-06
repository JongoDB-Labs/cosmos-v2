# Feedback auto-remediation loop

Automatically turn incoming feature requests and bug reports into tracked,
triaged work — so nothing sits in the feedback inbox waiting to be actioned
(FR `695aa097`).

## What it does

```
new feedback (OPEN)
      │
      ▼  scheduled poll (every 6h) → POST /feedback/remediate
   AI triage  ── best-effort; heuristic fallback if the model is unreachable
      │        (classification · severity · effort · acceptance criteria)
      ▼
  create work item in the target project's backlog
      │        (priority from severity, tagged `auto-triaged`, links back
      │         to the feedback item, description carries the criteria)
      ▼
  stamp feedback deliveredAt + workItemId + triage, status → PLANNED
```

The loop only ever **files work**. It never edits code, merges, or deploys. It
is:

- **Idempotent** — the poller only picks up rows with `deliveredAt IS NULL`, and
  the create + stamp happen in one transaction, so an item is delivered exactly
  once no matter how often the job runs.
- **Opt-in per org** — off unless enabled with a target project (Settings →
  Feedback Automation, or `Organization.settings.autoRemediation`).
- **Per-run capped** — default 10 items, max 50, oldest-highest-voted first.

## Configure (in-app)

Settings → **Feedback Automation**:

1. Toggle **Auto-triage feedback** on.
2. Pick the **target project** (its first board's leftmost To-Do column receives
   the items).
3. **Save**. Use **Run now** to deliver immediately without waiting for the cron.

Requires org-admin (`ORG_UPDATE`). AI triage uses the org's configured model
(Settings → AI); if none is set, delivery still happens with a heuristic
classification.

## Activate the scheduled poller

The `feedback-remediation` GitHub Action polls on a 6-hour cron but is **inert
until configured**. Set, on the repo (or an environment):

| kind      | name              | value                                            |
| --------- | ----------------- | ------------------------------------------------ |
| variable  | `COSMOS_BASE_URL` | e.g. `https://defcon.fightingsmartcyber.com`     |
| variable  | `COSMOS_ORG_ID`   | the target org's UUID                            |
| secret    | `COSMOS_API_KEY`  | an org API key (`cosmos_…`, scope `items:write`) |

Mint the key in Settings → API Keys. You can also run the workflow manually
(`workflow_dispatch`) with a `limit`.

## Optional: draft fixes as PRs

The delivered work items flow through the normal board, where a person — or an
agent — picks them up. To bridge to an autonomous first-draft, adopt the
template workflow:

1. Review `.github/workflows/feedback-remediation-pr.yml.template` end-to-end.
2. Add `ANTHROPIC_API_KEY` (or your provider), pin the coding-agent action to a
   vetted SHA, wire the commented step.
3. Rename it to `feedback-remediation-pr.yml`.

It is `workflow_dispatch`-only and opens **draft** PRs — never ready-for-review,
never merged. Keep it dispatch-only until you trust it. Commits use the
maintainer identity, no assistant attribution (per the repo's authoring policy).

## Guardrails summary

- Never merges, deploys, or edits code (the in-app loop only files work items).
- Exactly-once delivery via `deliveredAt` + atomic create/stamp.
- Off by default; a live, non-archived target project is required to enable.
- Single-item failures don't abort a run; the item is retried next pass.
- Every delivery is audit-logged (`feedback.delivered`) and emits a realtime
  `feedback.delivered` event.
