// Seed the project-wide (orgId NULL) Foreman build skills. Idempotent: upserts each
// by (orgId:null, name) via findFirst — Postgres treats NULLs as distinct in the
// (org_id,name) unique index, so we enforce project-scope uniqueness in app code.
// Run once at deploy: `tsx scripts/foreman/seed-harness.mts`.
import { prisma } from "@/lib/db/client";

interface Seed {
  name: string;
  description: string;
  body: string;
}

const SKILLS: Seed[] = [
  {
    name: "cosmos-architecture",
    description: "How the cosmos-v2 codebase is laid out — Next.js app, Prisma, and the Foreman daemon — and the pure-core/IO split you must follow.",
    body: `---
name: cosmos-architecture
description: How cosmos-v2 is laid out and the pure-core/IO split to follow.
---

# cosmos-v2 architecture

- **App**: Next.js (App Router) under \`src/app\` (API routes at \`src/app/api/v1/orgs/[orgId]/...\`), UI in \`src/components\`, shared logic in \`src/lib\`.
- **DB**: Prisma + PostgreSQL. Schema at \`prisma/schema.prisma\`; the client is \`@/lib/db/client\` (\`prisma\`).
- **Foreman daemon**: \`scripts/foreman/*.mts\` (run via tsx) — the autonomous delivery loop. It is NOT the app; it runs from the git checkout.

## The pure-core / IO split (follow it)
Put **pure logic** in \`src/lib/foreman/*.ts\` (no I/O) — it is unit-tested with vitest (which cannot load the \`.mts\` daemon files). Put **I/O** (DB, fs, network, git) in \`scripts/foreman/*.mts\`, thin, delegating to the pure core. Mirror the existing pairs: \`planner.ts\` ↔ the daemon loop, \`supervisor.ts\` ↔ \`supervisor-run.mts\`, \`harness.ts\` ↔ \`harness-io.mts\`.

## Path aliases
\`@/...\` resolves to \`src/...\` (tsconfig paths). Daemon \`.mts\` files import siblings as \`./x.mjs\` (resolves the \`.mts\`) and app modules as \`@/lib/...\`.
`,
  },
  {
    name: "cosmos-prisma-migrations",
    description: "How to add/change a Prisma model safely: edit the schema, generate the migration OFFLINE (never migrate against a live DB), keep it additive.",
    body: `---
name: cosmos-prisma-migrations
description: Safe Prisma schema changes and offline migration generation.
---

# Prisma migrations in cosmos-v2

1. Edit \`prisma/schema.prisma\` — add the model with \`@@map("snake_case_table")\`, \`@map("snake_case_col")\` on fields, and any \`@@unique\`. Add the back-relation on \`model Organization\`.
2. **Generate the migration OFFLINE** — NEVER \`prisma migrate dev\` (it connects to a DB and could hit prod):
   \`\`\`bash
   git show HEAD:prisma/schema.prisma > /tmp/old.prisma
   TS=$(date -u +%Y%m%d%H%M%S)_your_name && mkdir -p prisma/migrations/$TS
   npx prisma migrate diff --from-schema /tmp/old.prisma --to-schema prisma/schema.prisma --script > prisma/migrations/$TS/migration.sql
   \`\`\`
3. \`npx prisma validate\` (expect "valid") and \`npx prisma generate\`.
4. Keep migrations **additive** (CREATE TABLE / ADD COLUMN). Avoid destructive DROP/ALTER on live tables.
5. Postgres treats \`NULL\` as **distinct** in a unique index, so \`@@unique([orgId, name])\` does NOT enforce uniqueness for rows where \`orgId IS NULL\` — enforce that case in app code or a partial index.
6. A migration deploys via the \`deploy-migrate.sh\` path (runs \`prisma migrate deploy\`), not \`deploy-apponly.sh\`.
`,
  },
  {
    name: "cosmos-testing",
    description: "Test conventions: vitest, pure-core unit tests, integration/DB tests are CI-only, and strict TDD (red before green).",
    body: `---
name: cosmos-testing
description: How to test in cosmos-v2 — vitest, pure vs integration, strict TDD.
---

# Testing in cosmos-v2

- **Runner**: vitest. Unit tests are \`*.test.ts(x)\` next to the code.
- **Pure logic** (\`src/lib/foreman/*.ts\`) is fully unit-testable — this is where the bulk of testable logic must live.
- **Integration/DB tests** (anything importing \`prisma\` and hitting the DB) are **CI-only** in this environment — there is no local test DB, and you must NEVER run them against the production DB. Write them; let CI validate them.
- **Daemon \`.mts\` files** cannot be loaded by vitest — do not put testable logic there; extract it to a \`src/lib\` pure module.
- **TDD is required**: write the failing test → run it and SEE it fail → write the minimal implementation → run it and SEE it pass. A test that asserts nothing (or is written after the code with no red step) is a defect.
- Assert real behavior (values, shapes), not just truthiness.
`,
  },
  {
    name: "cosmos-release-discipline",
    description: "The release invariant (CHANGELOG top === package.json version), version bumps, and the manual PR → --admin → deploy ship flow.",
    body: `---
name: cosmos-release-discipline
description: cosmos-v2 versioning, changelog invariant, and the ship flow.
---

# Release discipline

- **INVARIANT (CI-enforced):** \`CHANGELOG[0].version === package.json.version\`. The Config-assertions CI step FAILS the build if they differ. So **every version bump MUST prepend a matching \`CHANGELOG\` entry** in \`src/lib/changelog.ts\` (newest first), and never bump the version without one.
- **SemVer**: patch for fixes, minor for features, as befits the change.
- **Ship flow** (this repo ships manually; foreman code + sensitive paths never auto-ship):
  1. Branch, implement with tests, bump \`package.json\` + prepend the changelog entry.
  2. Open a PR; CI must be green (the required \`check\` + Config-assertions).
  3. \`gh pr merge --squash --admin\` → \`git tag vX.Y.Z && git push origin vX.Y.Z\` (the tag triggers the signed image build).
  4. Deploy: \`deploy-apponly.sh X.Y.Z\` (no schema change) or \`deploy-migrate.sh X.Y.Z\` (has a migration). The script health-gates.
  5. Daemon-code changes also need a foreman restart (it runs from the checkout).
`,
  },
  {
    name: "cosmos-foreman-conventions",
    description: "Foreman's own conventions: sensitive paths that never auto-ship, event-sourcing, and the rule to never weaken your own safety gates.",
    body: `---
name: cosmos-foreman-conventions
description: Conventions for changing Foreman's own delivery machinery safely.
---

# Foreman conventions

- **Sensitive paths** (see \`src/lib/foreman/risk.ts\`): \`scripts/foreman/\`, \`src/lib/foreman/\`, \`src/lib/auth/\`, \`src/lib/rbac/\`, \`/abac/\`, \`src/lib/ai/egress/\`, \`Dockerfile\`, \`next.config.ts\`, \`.deploy/\`, \`.github/workflows/\`, and schema/migration changes. Changes touching them are risk-gated and **never auto-shipped** — they always park for human review. Never weaken this gate.
- **Never weaken your own safety gates.** Do not broaden \`allowedTools\`/\`permissionMode\`, loosen the risk gate, or remove a review step to make a change ship. If a change is blocked for safety, that is working as intended.
- **Event-sourcing**: board/outcome actions are recorded as \`foreman_events\` (kind is a string). When you mutate state, record the event first (or reflect reality) so actions are auditable and reversible.
- **Pure-core / IO split** applies to foreman code too (see cosmos-architecture): pure decisions in \`src/lib/foreman\`, IO in \`scripts/foreman/*.mts\`.
- Keep changes minimal and scoped to the ticket; do not "while I'm here" refactor unrelated code.
`,
  },
];

async function main(): Promise<void> {
  let created = 0;
  let updated = 0;
  for (const s of SKILLS) {
    const existing = await prisma.foremanSkill.findFirst({ where: { orgId: null, name: s.name } });
    if (existing) {
      await prisma.foremanSkill.update({
        where: { id: existing.id },
        data: { description: s.description, body: s.body, source: "seeded", enabled: true },
      });
      updated += 1;
    } else {
      await prisma.foremanSkill.create({
        data: { orgId: null, name: s.name, description: s.description, body: s.body, source: "seeded", enabled: true },
      });
      created += 1;
    }
  }
  console.log(`seed-harness: ${created} created, ${updated} updated (${SKILLS.length} project skills)`);
  await prisma.$disconnect();
}

void main();
