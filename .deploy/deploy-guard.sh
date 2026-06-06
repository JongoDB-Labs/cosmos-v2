#!/usr/bin/env bash
# COSMOS deploy-freeze guard — PreToolUse:Bash hook.
#
# While a coordinated prod deploy is in progress (the file .deploy-lock exists at
# the repo root), refuse the dangerous commands that would collide with it:
# DB migrations, db execute/push, production builds, and service start/stop/restart.
# This lets concurrent Claude sessions keep reading/planning but not mutate the
# shared DB / shared .next / the live :3000 server mid-deploy.
#
# Arm the freeze:   touch /home/defcon/cosmos-saas/.deploy-lock
# Lift the freeze:  rm    /home/defcon/cosmos-saas/.deploy-lock
#
# NOTE/LIMITS: this only guards Claude sessions whose settings load this hook
# (reliably the main checkout). It does NOT stop the systemd cosmos-deploy.service
# auto-deployer, nor a command already mid-run, nor (necessarily) worktree
# sessions. The human stand-down (.deploy/STAND-DOWN.md) is the primary signal.

LOCK="/home/defcon/cosmos-saas/.deploy-lock"
[ -f "$LOCK" ] || exit 0   # no freeze -> allow everything

# Extract the Bash command from the hook's JSON stdin (node is always present here).
CMD="$(cat 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(((JSON.parse(s).tool_input)||{}).command||"")}catch(e){process.stdout.write("")}})' 2>/dev/null)"

case "$CMD" in
  *"prisma migrate"*|*"prisma db execute"*|*"prisma db push"*|*"npm run build"*|*"next build"*|*"pnpm build"*|*"systemctl restart"*|*"systemctl start"*|*"systemctl stop"*)
    echo "DEPLOY FREEZE ACTIVE (.deploy-lock present): a coordinated prod deploy is in progress." >&2
    echo "Blocked: migrations / builds / service restarts. Coordinate in the deploy session; do NOT proceed." >&2
    echo "(If you ARE the deploy session, lift the freeze first: rm $LOCK)" >&2
    exit 2 ;;
esac
exit 0
