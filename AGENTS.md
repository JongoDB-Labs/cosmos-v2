<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Versioning

Bump `package.json`'s `version` for every user-visible code change using SemVer:
- **patch** (1.7.0 → 1.7.1): bug fixes, internal refactors, dependency bumps
- **minor** (1.7.0 → 1.8.0): new features, non-breaking additions
- **major** (1.7.0 → 2.0.0): breaking API or DB schema changes

The version is surfaced in the sidebar via `NEXT_PUBLIC_APP_VERSION`, built from `npm_package_version` in `next.config.ts:5` — `package.json` is the single source of truth for what's running.

**Use `npm run release:bump <version>`, not `npm version`.** The composed-plugin tree needs the bump staged specially, and CI's "Config assertions" job fails the build unless `package.json`'s version equals the TOP `version:` in `src/lib/changelog.ts` — so every bump needs a user-facing changelog entry in the same commit.

`release:bump` deliberately leaves the index and the working tree disagreeing: it stages the version-only `package.json`, then restores the composed tree **on disk**. Two consequences, in opposite directions:

- In the main checkout, `scripts/plugins/sync.mjs` marks `package.json`, `package-lock.json` and `prisma/schema.prisma` skip-worktree, so edits to those files silently never commit. Run `node scripts/plugins/sync.mjs --clean` before editing them.
- In a fresh `git worktree` nothing is skip-worktree, so a later **`git add -A` stages the restored file and reverts the bump**, and CI fails with `CHANGELOG top (X) != package.json version (Y)`.

Either way: run the bump, then commit immediately with only the changelog explicitly added — never `git add -A` afterwards. Verify with `git show HEAD:package.json | grep '"version"'` before pushing.

When several changes are in flight, pick the version against `origin/main` **at merge time**; a stale claim from an earlier rebase fails the parity gate.

# Before you push: check `e2e/`

`tsc`, `eslint` and `vitest` never load `e2e/`, so a renamed or removed UI affordance breaks Playwright silently and CI fails 15+ minutes later. The specs locate elements by accessible name — button text, tab labels, placeholders, `aria-label`s, headings.

For every label you rename or remove, `grep -rn "<old label>" e2e/`. If a *seeding* affordance goes away, replace it with a shared helper in `e2e/fixtures/` rather than patching each spec. Do this **before** implementing where you can: an existing spec's selector is a constraint on your design, not just a thing to fix afterwards.

# Verification

- **Mutation-test your tests.** Break the source, confirm a *named* test fails, restore. A test that passes either way is worse than no test, because it reads as coverage. Watch for vacuity in React tests specifically: re-rendering an identical element lets React bail out, so a test can pass against the very bug it guards.
- **`npx vitest run` has a large local baseline.** ~82 failures across ~31 files under `src/lib/{ai,feedback,files,ingest,org,rbac,work-items}` and `src/app/api/**` are `PrismaClientKnownRequestError`s from having no seeded test database. That set is expected; compare against it, and never let it mask a real failure in `src/components`.
- **`tsc` catches what vitest runs straight past** — vitest does not typecheck, so a test can pass with a missing required prop. Always finish with `npx tsc --noEmit 2>&1 | grep -v "^\.next/"`.
- **Validate a migration by applying it**, from scratch, to a throwaway database — then assert the behaviour it promises (defaults on existing rows, `ON DELETE` semantics), not just that it applied.
- **A green pipeline is not a delivered feature.** Deployment is pull-based: CI publishes an image and the Foreman daemon polls and deploys it. After it lands, drive the actual screen.

# Concurrent agents need separate worktrees

Two agents sharing one working tree destroy each other's uncommitted work — a branch switch in a shared checkout discards the other's edits and can land a commit on the wrong branch. Give each concurrent worker its own:

```
git worktree add <dir> origin/main -b <branch>
cd <dir> && npm ci && npx prisma generate
```

`prisma generate` is not optional — without it `tsc` reports dozens of phantom errors in `prisma/seed/**` and `e2e/**`. Note a worktree checks out **tracked files only**, so anything gitignored (`node_modules`, `.env`, `CLAUDE.md`) is absent and must be symlinked or copied in.

# Container image: never bake secrets in

The image is signed and published to `ghcr.io/jongodb-labs/cosmos-v2` and may be **public** — treat its filesystem as world-readable. Never bake secrets or sensitive info into a layer:

- **Secrets are runtime-only.** Credentials, tokens, keys, and connection strings come from env / mounted secrets / the sealed `ConnectorCredential` store — never `COPY`/`ADD`'d in or set via `ENV`/`ARG`. The DB URL stays `env("DATABASE_URL")` in `prisma/schema.prisma`; never hardcode one.
- **`NEXT_PUBLIC_*` is inlined into the public client bundle at build time** (`next.config.ts`), so it ships in readable JS. Only non-secret values may use that prefix (today: `APP_VERSION`, `PRODUCT`). Never put a secret behind a `NEXT_PUBLIC_*` name.
- **`public/` is served publicly** — static assets only; no `.env`, configs, or keys.
- **The runtime stage copies only specific build outputs** (`.next/standalone`, `.next/static`, `public`, `prisma`, `node_modules/.prisma`, the ML libs) — NOT the root context. When you add a `COPY --from=build` to the runtime stage, scope it to the exact artifact; never `COPY . .` into runtime.
- **`.dockerignore` keeps `.env*`, `deploy/secrets/`, and key material out of the build context** — keep those exclusions. They guard local builds (`.deploy/deploy-v2.sh`) where a developer's real `.env`/`.env.local` is on disk and would otherwise ride into the build stage via `COPY . .`.

# Cosmos-specific patterns (read before writing code that touches these surfaces)

## Cache Components is ON

`cacheComponents: true` is enabled in `next.config.ts`. Consequences for any code you write:

- **No dynamic API reads outside a `<Suspense>` boundary.** `cookies()`, `headers()`, `searchParams`, `params`, and `getCurrentUser()`/`getAuthContext()` (which read cookies) must all live inside a Suspense-wrapped child. The dashboard layout already follows this — model new pages after `(dashboard)/[orgSlug]/page.tsx`.
- **Pages that `await params` at the top break instant validation.** Pass `params` as a Promise into a Suspense child; await inside the child. See `(dashboard)/[orgSlug]/page.tsx` for the pattern.
- **No `runtime = "nodejs"` or `dynamic = "force-dynamic"`** as route-segment exports — Cache Components disallows them. Routes pick up the right behavior automatically.

## `unstable_instant` is DISABLED project-wide — do not add one

Instant-nav is currently off across the whole app: every `unstable_instant` export has been removed while a Turbopack build-validation bug is investigated. **Adding one back makes your route the only one that has it.** `grep -rn "unstable_instant" src/` returns only comments recording the removal; `(dashboard)/[orgSlug]/page.tsx` carries the canonical note.

This section used to point at that file and `.../projects/page.tsx` as "working examples", which stopped being true when the exports came out — a doc that survived the code it described, and then told people to add the one thing the codebase had deliberately removed.

Keep the knowledge for when it is re-enabled: a route reading dynamic params or cookies needs explicit `samples`, or the build fails with `E1109` / `E1115` even though TypeScript accepts the bare `{ prefetch: "static" }`. The Next.js docs (`instant.md`) don't mention it — only the build error catches it.

```ts
export const unstable_instant = {
  prefetch: "static" as const,
  samples: [
    { params: { orgSlug: "_" }, cookies: [{ name: "session", value: null }] },
  ],
  unstable_disableBuildValidation: true,
};
```

## Multi-tenant client cache (React Query)

Every client `useQuery` key MUST flow through `useOrgQueryKey(...)` from `@/lib/query/keys`. This prefixes the key with the current URL's org slug so switching orgs serves a different cache namespace — preventing cross-tenant cache bleed.

```tsx
const queryKey = useOrgQueryKey("themes");
// becomes ["org", "fsc", "themes"] when /fsc/... is loaded
```

Mutations use `useOrgMutation({ mutationFn, invalidate: [["themes"]] })` — same prefix, automatic invalidation.

**Exception — instance-level `/admin/*` routes.** `useOrgSlug()` returns `null` for `admin`, `internal`, `onboarding` and `login`, so `useOrgQueryKey("x")` there produces `["org", null, "x"]`: a shared namespace that looks org-scoped and is not. These surfaces are instance-wide, so there is no cross-tenant bleed to prevent. Use a flat literal key instead, and match it in any server-side prefetch — `admin/allowlist` uses `["admin", "allowed-emails"]`, `admin/updates` uses `["admin", "updates"]`.

## Server-side response patterns

- **Permission masks are decimal-string `TEXT`, not `BigInt`.** `OrgMember.permissions` and `WorkRole.grants` store a permission bitmask as a decimal string (the bitfield in `src/lib/rbac/permissions.ts` assigns bits ≥ 63, which overflow Postgres `BIGINT`). Keep ALL bit-math on `bigint` and cross the DB boundary with `maskFromDb()` (read) / `maskToDb()` (write) from `@/lib/rbac/permissions` — never `BigInt(row.permissions)` or `mask` written raw. The `JSON.stringify`-throws-on-BigInt crash class is gone, but these are still permission masks: don't `select`/`include` them into a `success()` payload carelessly. Project members with an explicit `select` that excludes `permissions`, and expose `WorkRole.grants` only as permission KEYS via `toWorkRoleDto` — never the raw value.
- **Behind nginx + Cloudflare Tunnel** — `request.url` resolves to the bind hostname (`localhost:3000`), not the public URL. For any redirect, use `getPublicOrigin(request)` from `@/lib/auth/public-url` which honors `X-Forwarded-Host` + `X-Forwarded-Proto`.

## base-ui primitives don't support `asChild`

The project uses `@base-ui/react` for `Button`, `DropdownMenu`, and `Dialog` — NOT Radix shadcn. Consequence: `<Button asChild><Link href="..."/></Button>` doesn't compile.

Use one of:
- `<Link className={cn(buttonVariants(), "...")}>...</Link>` (standard pattern in topbar/sidebar)
- `<DropdownMenuItem onClick={() => router.push("...")}>...` (for menu items)

## `googleapis` + `pdfkit` are externalized

They're listed in `next.config.ts` `serverExternalPackages` because their CJS shape doesn't bundle cleanly. If you add another CJS-heavy server-side dep and the build complains about file-tracing or `.afm`-style asset loading, add it to that list.
