import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every module that renders the DEPLOYMENT brand must also load the seam that
 * registers it.
 *
 * getBrand() validates PRODUCT against PRODUCT_PROFILES and falls back to the
 * neutral brand for a key the registry does not have. A composed plugin adds
 * its own profile to that registry as a side effect of the neutral server seam,
 * `@/lib/plugins/registry/server` — and PRODUCT_PROFILES is a module-level
 * mutable singleton, so the profile is only there once something in that
 * process has actually imported the seam.
 *
 * Nothing guarantees that has happened by the time a request arrives. The
 * SIGN-IN PAGE is the case that loses: it is the first thing anyone hits after
 * a restart, so it rendered under the NEUTRAL product's name, title, tagline
 * and mark — and then healed silently the moment any other route pulled the
 * seam in, which is why it only ever reproduced on a cold container.
 *
 * Observed on a branded deployment, same process one minute apart:
 *
 *   cold                          the NEUTRAL product's title in the tab
 *   after one dashboard render    the deployment's own product title
 *
 * This is the same failure the model-credential seam documents (see
 * src/lib/ai/__tests__/model-credential-registration.arch.test.ts) and it fails
 * the same way: silently, into a plausible-looking default that no runtime
 * check can distinguish from a genuinely neutral deployment. A comment cannot
 * enforce the import, so it is checked statically here.
 *
 * SCOPE: the three modules that resolve the deployment brand for RENDERING.
 * Deliberately not every getBrand() caller — src/lib/auth/totp.ts,
 * src/lib/integrations/invitation-email.ts and src/lib/pdf/brand.ts have the
 * same exposure for an authenticator label, an invitation email and a PDF
 * letterhead, but those are reached from routes that have long since loaded the
 * seam, and widening this rule to them would pull every plugin's server hooks
 * into their graphs for no benefit yet demonstrated. The durable fix for those
 * is to register a product profile from the plugin MANIFEST (client-safe,
 * loaded by registry/index) rather than from its server hooks; until that
 * lands, this rule covers the surface that actually broke.
 */
const ROOT = process.cwd();
const SEAM = "@/lib/plugins/registry/server";

const BRAND_RENDERERS = [
  // <title>, description, apple-web-app title — generateMetadata, per request.
  "src/app/layout.tsx",
  // Seeds the client BrandProvider: the name, tagline and mark on the sign-in
  // page and the pre-login chrome.
  "src/components/providers/root-brand-provider.tsx",
  // name / short_name / icons in the web manifest.
  "src/app/manifest.ts",
  // Names the assistant in its page description, twice.
  "src/app/(dashboard)/[orgSlug]/settings/mcp-servers/page.tsx",
  // Tells the model which assistant it is.
  "src/lib/ai/assistant-prompt.ts",
];

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("deployment brand registration", () => {
  it.each(BRAND_RENDERERS)("%s loads the plugin composition seam", (rel) => {
    // Strip comments first: this file's own prose names the seam, and so does
    // the explanation sitting above the import in each of these modules.
    const code = source(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain(SEAM);
  });

  it.each(BRAND_RENDERERS)("%s actually resolves the brand", (rel) => {
    // Without this the rule above is decorative: a module that stopped reading
    // the brand would still "pass" while carrying a pointless import, and a
    // module renamed out from under the list would vanish from the rule
    // entirely. Assert the pairing, not just the import.
    expect(source(rel)).toContain("getBrand");
  });
});
