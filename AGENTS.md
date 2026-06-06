<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Versioning

Bump `package.json`'s `version` for every user-visible code change using SemVer:
- **patch** (1.7.0 → 1.7.1): bug fixes, internal refactors, dependency bumps
- **minor** (1.7.0 → 1.8.0): new features, non-breaking additions
- **major** (1.7.0 → 2.0.0): breaking API or DB schema changes

The version is surfaced in the sidebar via `NEXT_PUBLIC_APP_VERSION`, built from `npm_package_version` in `next.config.ts:5` — `package.json` is the single source of truth for what's running. Use `npm version patch|minor|major` (it edits `package.json` and creates a git tag), or edit `version` directly when you don't want the tag.

# Cosmos-specific patterns (read before writing code that touches these surfaces)

## Cache Components is ON

`cacheComponents: true` is enabled in `next.config.ts`. Consequences for any code you write:

- **No dynamic API reads outside a `<Suspense>` boundary.** `cookies()`, `headers()`, `searchParams`, `params`, and `getCurrentUser()`/`getAuthContext()` (which read cookies) must all live inside a Suspense-wrapped child. The dashboard layout already follows this — model new pages after `(dashboard)/[orgSlug]/page.tsx`.
- **Pages that `await params` at the top break instant validation.** Pass `params` as a Promise into a Suspense child; await inside the child. See `(dashboard)/[orgSlug]/page.tsx` for the pattern.
- **No `runtime = "nodejs"` or `dynamic = "force-dynamic"`** as route-segment exports — Cache Components disallows them. Routes pick up the right behavior automatically.

## `unstable_instant` requires explicit `samples` for dynamic routes

When adding instant-navigation validation to a route that reads dynamic params or cookies, the bare `{ prefetch: "static" }` fails the build with `E1109` / `E1115` even though TypeScript accepts it. You must declare `samples` so the validator can simulate a navigation:

```ts
export const unstable_instant = {
  prefetch: "static" as const,
  samples: [
    { params: { orgSlug: "_" }, cookies: [{ name: "session", value: null }] },
  ],
};
```

See `(dashboard)/[orgSlug]/page.tsx` and `.../projects/page.tsx` for working examples. The Next.js docs (`instant.md`) don't mention this — only the build error catches it.

## Multi-tenant client cache (React Query)

Every client `useQuery` key MUST flow through `useOrgQueryKey(...)` from `@/lib/query/keys`. This prefixes the key with the current URL's org slug so switching orgs serves a different cache namespace — preventing cross-tenant cache bleed.

```tsx
const queryKey = useOrgQueryKey("themes");
// becomes ["org", "fsc", "themes"] when /fsc/... is loaded
```

Mutations use `useOrgMutation({ mutationFn, invalidate: [["themes"]] })` — same prefix, automatic invalidation.

## Server-side response patterns

- **`OrgMember.permissions` is BigInt** — including it in any Prisma `include`/`select` and returning the result via `success()` will break `JSON.stringify`. Always project members with an explicit `select` that excludes `permissions`.
- **Behind nginx + Cloudflare Tunnel** — `request.url` resolves to the bind hostname (`localhost:3000`), not the public URL. For any redirect, use `getPublicOrigin(request)` from `@/lib/auth/public-url` which honors `X-Forwarded-Host` + `X-Forwarded-Proto`.

## base-ui primitives don't support `asChild`

The project uses `@base-ui/react` for `Button`, `DropdownMenu`, and `Dialog` — NOT Radix shadcn. Consequence: `<Button asChild><Link href="..."/></Button>` doesn't compile.

Use one of:
- `<Link className={cn(buttonVariants(), "...")}>...</Link>` (standard pattern in topbar/sidebar)
- `<DropdownMenuItem onClick={() => router.push("...")}>...` (for menu items)

## `googleapis` + `pdfkit` are externalized

They're listed in `next.config.ts` `serverExternalPackages` because their CJS shape doesn't bundle cleanly. If you add another CJS-heavy server-side dep and the build complains about file-tracing or `.afm`-style asset loading, add it to that list.
