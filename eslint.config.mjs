import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
