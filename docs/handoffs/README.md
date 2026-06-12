# Dedicated-session handoffs

Each file here is a self-contained brief for ONE large feedback FR that warrants
its own focused Claude Code session (too big to do well inline among the smaller
items). Start a fresh session, point it at the relevant file, and have it execute
end-to-end.

**Shared context every session needs (don't re-derive):**
- Repo: `/home/defcon/cosmos-v2`. Prod runs in Docker, health at `http://localhost:8090/api/health`, currently **2.81.1**. Deploy loop: bump `package.json` (`npm version <patch|minor> --no-git-tag-version`) → `sudo docker build -t cosmos-v2:dev .` → (if schema) `sudo docker build --target migrate -t cosmos-v2-migrate:dev .` + `sudo docker compose run --rm cosmos-migrate` → `sudo docker compose up -d --no-deps --force-recreate cosmos` → verify health. **Migrate-then-deploy ordering matters** for data migrations.
- Commit as JongoDB/COSMOS Agent, **no Claude/Anthropic attribution**. Commits accumulate locally; the **user pushes** (agent cannot). Keep `CLAUDE.md`/`AGENTS.md`/`docs/superpowers` gitignored.
- **Read `node_modules/next/dist/docs/` before writing Next code** — this is a modified Next 16 with Cache Components ON (dynamic reads inside `<Suspense>`); base-ui (NOT Radix) for Select/Dialog/DropdownMenu; design tokens are HEX (no `hsl(var())`).
- Verify in a real browser via Playwright: chromium at `~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`; **BASE must be `http://localhost:3000`** for browser tests (Next 16 dev blocks `/_next/` client chunks from `127.0.0.1` → no hydration); use `127.0.0.1` only for node `fetch`. Test stack: ephemeral postgres on `:55440` (`DATABASE_URL=postgres://cosmos:e2epw@localhost:55440/cosmos`), dev server `npm run dev` on `:3000` with `E2E_TEST_AUTH=1`; sign in `POST /api/testenv/sign-in {email}` (Origin header). Seed: org `test-org`, `alice@test.local` (ADMIN), project `TEST`, kanban board `78a1b12c-03e7-4678-af7a-7025f075c69b`, timeline board `9e07562b-76cb-4884-939d-791f271bb54a`.
- **NEVER `kill` a host process owned by uid 999 / with a bogus ELAPSED — it's a Docker container (incl. prod); check `ps -o user,etime` first.** Manage containers via `docker compose` only.
- **Mark the prod feedback item DONE** when finished: `sudo docker exec cosmos-v2-cosmos-postgres-1 psql -U cosmos -d cosmos -c "UPDATE feedback_items SET status='DONE', updated_at=now() WHERE id::text LIKE '<prefix>%';"` (status enum OPEN/PLANNED/IN_PROGRESS/DONE/DECLINED). Append a one-line entry to `OVERNIGHT_BUILD_LOG.md`.

**The four handoffs:**
1. `roadmap-content-and-section.md` — dedicated Roadmap section + populate issue descriptions from the VITL roadmap + COA-1 POAMs.
2. `custom-fields-on-tickets.md` — render org/project custom fields on work items + make them filterable.
3. `tag-any-entity.md` — extend @-mentions beyond people to issues/projects/docs/etc.
4. `microsoft-teams-integration.md` — wire the Microsoft Teams connector end-to-end.
