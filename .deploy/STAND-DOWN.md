# Single paste — ONE per session

## → Paste into EACH OTHER session (assistant, notes, meetings, finance, chat)
Self-enforcing + self-resuming: pause, and resume yourself when the freeze lifts.

```
🚨 PROD DEPLOY FREEZE. A coordinated production deploy (main 3.39.0 → 4.5.0, including a
breaking Float→Decimal migration) is running against the SHARED database and the live
:3000 server. Stop now. Until the file /home/defcon/cosmos-saas/.deploy-lock no longer
exists, do NOT run any: prisma migrate / prisma db execute / db push, npm run build /
next build, systemctl or server start/stop/restart, or git merge/push to main. (A guard
hook also hard-blocks those while the lock exists.) Reading/planning/editing is fine.
Reply "idle — holding". Before you resume ANY of the above later, first run
`ls /home/defcon/cosmos-saas/.deploy-lock` — if it's gone, the deploy is done: run
`git pull` and continue; if it still exists, keep holding.
```

## → Paste into the DEPLOY session (the one that runs it)
One shot — runs the whole coordinated deploy with preflight aborts, verify, and rollback guidance.

```
Run the coordinated production deploy. First `bash /home/defcon/cosmos-saas/.deploy/deploy.sh`
(dry-run) and show me the plan + pending migrations. If it looks right, run
`bash /home/defcon/cosmos-saas/.deploy/deploy.sh go` and report each step. The script arms
the freeze, snapshots the DB (money SUMs + pg_dump), stages main in /home/defcon/cosmos-prod,
aborts cleanly before the breaking step on any failure, then migrate→build→restart→verify and
lifts the freeze. If it halts after the migration (freeze still armed), follow the rollback in
.deploy/deploy-runbook.md and tell me — do not improvise destructive DB changes.
```

(No-agent alternative for the deploy session: just type `!bash /home/defcon/cosmos-saas/.deploy/deploy.sh go`.)
