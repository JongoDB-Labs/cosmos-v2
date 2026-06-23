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
  ]),
]);

export default eslintConfig;
