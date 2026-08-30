import { defineConfig, globalIgnores } from "eslint/config";
import { createRequire } from "node:module";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint 10 removed context.getFilename(), which eslint-plugin-react (bundled by
// eslint-config-next, ≤7.37.5) still calls when AUTO-DETECTING the React version
// — crashing every React rule with "contextOrFilename.getFilename is not a
// function". Pin the version explicitly so the plugin skips detection; read it
// from the installed React so it never goes stale. Harmless on eslint 9.
const reactVersion = createRequire(import.meta.url)("react/package.json").version;

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Pin React's version (see the note above) so eslint-plugin-react doesn't run
  // its eslint-10-incompatible version detection.
  { settings: { react: { version: reactVersion } } },
  // Resilience guard (locks in the Round 20 work): a catch block whose ONLY
  // action is console.error swallows a failure with no user feedback. Surface
  // it via notifyError(err, ...) from @/lib/errors/notify, an inline error, or
  // a toast. A genuinely best-effort/background catch can opt out with an
  // inline disable comment + a reason.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CatchClause > BlockStatement[body.length=1] > ExpressionStatement > CallExpression[callee.object.name='console'][callee.property.name='error']",
          message:
            "A catch that only console.error()s is invisible to the user. Surface the failure (notifyError(err, …) from @/lib/errors/notify, an inline error, or a toast); for a deliberately silent best-effort catch add an eslint-disable-next-line with a reason.",
        },
      ],
    },
  },
  // Single-path egress guard: the Anthropic SDK provider is reachable ONLY
  // from inside `src/lib/ai/egress/`. Everything else must go through
  // `runModelTurn()` (the chokepoint that projects + logs each value). This is
  // the lint half of the invariant; `single-path.arch.test.ts` is the test half.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/ai/egress/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/ai/egress/provider", "@/lib/ai/egress/provider"], message: "Reach the model only via runModelTurn() from @/lib/ai/egress — never the provider directly." },
        ],
      }],
    },
  },
  // A value read before it is declared is a RUNTIME error TypeScript cannot see.
  //
  // On 2026-08-30 a build that introduced a flaky test crashed instead of being
  // held for review: a park closure read a counter that a later release had
  // moved its declaration below. `tsc` accepts it — the reference is legal, and
  // TS2448 does not fire through a closure — and the file it lives in is `.mts`,
  // which vitest cannot load, so nothing caught it before production.
  //
  // Scoped to src/plugins/** because that is where it is CLEAN today (0
  // violations) and where the cost is highest: a plugin's daemon half runs from
  // a host checkout with no test coverage at all. The same rule reports 19
  // violations across core components — real, worth fixing, and deliberately not
  // swept into this change.
  {
    files: ["src/plugins/**/*.{ts,tsx,mts}"],
    rules: {
      "no-use-before-define": ["error", { variables: true, functions: false, classes: false }],
    },
  },
  // Plugin isolation (ADR 0003): shared code may import src/plugins/** ONLY via
  // the two composition files (src/lib/plugins/registry/{index,server}.ts) and
  // the thin (plugin-*) route shims under src/app. This is the editor-time half;
  // plugin-isolation.arch.test.ts is the test half (which also enforces shim
  // thinness and bans a plugin's prisma.<slug>* models outside that plugin).
  //
  // Flat-config note: same-rule options REPLACE (never merge) across matching
  // config objects, so this block re-states the egress-provider pattern above —
  // for files both blocks match, this later value wins and must carry both.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/plugins/**",
      "src/lib/plugins/registry/**",
      "src/app/**",
      "src/lib/ai/egress/**",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/ai/egress/provider", "@/lib/ai/egress/provider"], message: "Reach the model only via runModelTurn() from @/lib/ai/egress — never the provider directly." },
          { group: ["@/plugins/**", "**/src/plugins/**"], message: "Shared code must not import plugin code directly — plugins register through @/lib/plugins/registry/{index,server} (ADR 0003)." },
        ],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Playwright E2E tests — not Next.js/React code, skip React lint rules.
    "e2e/**",
    // Claude Code session data + transient agent git worktrees. Linting these
    // re-lints stale copies of the whole tree (and isn't real source anyway).
    ".claude/**",
    // Private plugin checkouts (ADR 0003). scripts/plugins/sync.mjs composes
    // their overlay/** into src/plugins/<slug>/** at build time — THOSE composed
    // copies get linted; the raw checkout here is a staging area (and its
    // @/plugins/* imports only resolve once composed). Mirrors tsconfig exclude
    // + .gitignore + .dockerignore.
    "plugins/**",
  ]),
]);

export default eslintConfig;
