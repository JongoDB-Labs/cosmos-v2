import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every module that RESOLVES a model credential must also LOAD the registry that
 * registers the resolver.
 *
 * `resolver` in model-credential-provider.ts is a module-level singleton, set as a
 * side effect of importing `@/lib/plugins/registry/server` (which loads the plugin
 * server hooks). Next.js bundles route handlers separately, so a registration in
 * one route's module graph does not reach another's — and nothing does it at boot:
 * `instrumentation.ts` is OpenTelemetry wiring, despite an older comment crediting
 * it with this.
 *
 * The failure is invisible by construction. `resolveModelCredential` is fail-safe:
 * no provider ⇒ null ⇒ callers degrade quietly. So "the plugin never registered
 * here" and "the org has no subscription" produce the same null, and the caller
 * cannot tell them apart. On prod (2026-08-26) that left the feedback-automation
 * toggle greyed out with a banner telling an admin to connect a Claude account
 * that was already connected and healthy, and left BOTH intake judges — duplicate
 * detection and the security judge — running without a credential and reporting
 * nothing wrong.
 *
 * A comment cannot enforce this and a runtime check cannot see it, so it is
 * checked statically here: the import is a load-bearing dependency, not a style
 * preference.
 */
const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const REGISTRY_IMPORT = "@/lib/plugins/registry/server";
const CALL = "resolveModelCredential";

/** The module that DEFINES the seam is exempt: it is what gets registered into. */
const EXEMPT = ["src/lib/ai/model-credential-provider.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(SRC).filter((f) => {
  const rel = relative(ROOT, f);
  if (EXEMPT.includes(rel)) return false;
  // Tests register their own stub resolver, so they are not consumers of the seam.
  return !/\.(test|spec)\.(ts|tsx|mts)$/.test(rel) && !rel.includes("__tests__");
});

const callers = files.filter((f) => readFileSync(f, "utf8").includes(CALL));

/**
 * The feedback pipeline runs on FOREMAN's Claude account, not the org's. So any
 * gate in it that asks "is a model connected?" must consider Foreman's provider,
 * not only `org_ai_settings`.
 *
 * Getting this wrong once cost a four-week outage of a different kind: the
 * remediation worker skipped every run with `no-ai-credential` while Foreman's
 * subscription sat connected in another table. Fixing only the CONFIG endpoint
 * (2.307.0) made it briefly worse — the screen reported "connected" and enabled
 * the toggle while the worker still refused to run, which is a false green with a
 * UI attached.
 */
const FEEDBACK_PIPELINE = /^src\/(lib\/feedback\/|app\/api\/v1\/orgs\/\[orgId\]\/feedback\/)/;
const ORG_ONLY_STATUS = "getAiProviderStatus";

describe("feedback-pipeline AI gates", () => {
  const gates = files.filter((f) => {
    const rel = relative(ROOT, f);
    return FEEDBACK_PIPELINE.test(rel) && readFileSync(f, "utf8").includes(ORG_ONLY_STATUS);
  });

  it("finds the gates at all — a silent zero would make this vacuous", () => {
    expect(gates.length).toBeGreaterThan(0);
  });

  it("every one also considers Foreman's own provider", () => {
    const orgOnly = gates
      .filter((f) => !readFileSync(f, "utf8").includes(CALL))
      .map((f) => relative(ROOT, f));
    expect(
      orgOnly,
      `These gate the feedback pipeline on ${ORG_ONLY_STATUS} alone, which reads ` +
        `org_ai_settings. Foreman runs on its OWN credential (foreman_ai_settings), ` +
        `so an org with Claude connected for Foreman and nothing else is refused. ` +
        `Also consider ${CALL}().`,
    ).toEqual([]);
  });
});

describe("model-credential registration", () => {
  it("finds callers at all — a silent zero here would make this test vacuous", () => {
    expect(callers.length).toBeGreaterThan(0);
  });

  it("every caller of resolveModelCredential also imports the plugin registry", () => {
    const offenders = callers
      .filter((f) => !readFileSync(f, "utf8").includes(REGISTRY_IMPORT))
      .map((f) => relative(ROOT, f));
    expect(
      offenders,
      `These call ${CALL}() without importing "${REGISTRY_IMPORT}", so the resolver is ` +
        `never registered in their module scope and the call returns null no matter how ` +
        `the org is configured. Add: import "${REGISTRY_IMPORT}";`,
    ).toEqual([]);
  });
});
