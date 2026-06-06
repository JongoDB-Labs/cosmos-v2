# .deploy/ — coordinated-deploy kit (local, untracked)

These files are **local/untracked** (via `.git/info/exclude`) so they never land on any
feature branch. They exist to make a safe, coordinated prod deploy repeatable in a repo
shared by multiple concurrent Claude sessions + a live `:3000` demo on ONE shared DB.

| file | purpose |
|---|---|
| `deploy-runbook.md` | The exact ordered procedure for main → prod (3.39.0→4.5.0), incl. the breaking Float→Decimal window, the auto-deployer pause, stray-proc cleanup, verify, and rollback. |
| `deploy-guard.sh` | `PreToolUse:Bash` hook (wired in `.claude/settings.local.json`). While `.deploy-lock` exists, it **refuses** migrate / db execute / build / service start-stop-restart in guarded sessions. |
| `snapshot-baseline.sh` | Captures money SUMs + a `pg_dump` to `backups/` — the pre-deploy baseline + rollback safety net. |
| `STAND-DOWN.md` | Copy-paste message to pause the other sessions. |
| `backups/` | pg_dump rollback dumps. |

## The freeze
- **Arm:**  `touch /home/defcon/cosmos-saas/.deploy-lock`
- **Lift:** `rm /home/defcon/cosmos-saas/.deploy-lock`

## Limits (be honest about these)
- The guard hook reliably covers Claude sessions that load the main checkout's
  `.claude/settings.local.json`. It may NOT reach worktree sessions, can't interrupt a
  command already mid-run, and does NOT stop `cosmos-deploy.service` (the systemd
  auto-deploy webhook — pause that separately, per the runbook). **The human stand-down
  (`STAND-DOWN.md`) is the primary coordination signal; the lock/hook is a safety net.**

## Quick start (deploy day)
1. Paste `STAND-DOWN.md` into the other sessions; wait for "idle — holding".
2. `touch .deploy-lock` ; `sudo -n systemctl stop cosmos-deploy.service`.
3. `bash .deploy/snapshot-baseline.sh` (save the SUMs; confirm a dump exists).
4. Follow `deploy-runbook.md` steps 1–6.
5. `rm .deploy-lock` ; re-enable auto-deploy ; tell sessions to resume + `git pull`.
