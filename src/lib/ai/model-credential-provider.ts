/**
 * Model-credential provider seam (ADR 0003 decoupling, P1.5).
 *
 * Core's feedback-intake judges (duplicate detection + scope classification in
 * intake-guardrails.ts, and the security judge) need a model credential to run an
 * LLM turn. That credential used to come from Foreman's per-org Claude subscription
 * via a direct `@/plugins/foreman/lib/claude-subscription` import — a core→Foreman
 * coupling that blocked extracting Foreman to its own repo.
 *
 * This registry inverts it: core resolves the credential through
 * `resolveModelCredential`, and whoever OWNS the credential (the Foreman plugin)
 * registers a provider from its server hooks. FAIL-SAFE by construction: when no
 * provider is registered (Foreman not composed / not enabled) the resolver returns
 * null and the intake judges degrade gracefully — exactly the behavior when the
 * subscription is unavailable. It never throws.
 */

/** Resolves an org's model credential for internal AI, or null when unavailable. */
export type ModelCredentialResolver = (
  orgId: string,
) => Promise<{ accessToken: string } | null>;

let resolver: ModelCredentialResolver | null = null;

/**
 * Register the process-wide credential provider (idempotent — last write wins).
 * Called by whoever owns the credential — the Foreman plugin's server hooks
 * (src/plugins/foreman/server.ts), loaded through the neutral plugin composition
 * seam (src/lib/plugins/registry/server.ts).
 *
 * THIS DOES NOT HAPPEN AUTOMATICALLY AT BOOT. `resolver` is a module-level
 * singleton, so it is only set in module scopes where something actually imported
 * the registry. Next.js bundles route handlers separately, so a registration done
 * in one route's graph does not reach another's — and `instrumentation.ts`, which
 * an older comment credited with doing this, is OpenTelemetry wiring that imports
 * no such thing.
 *
 * Consequence, observed on prod 2026-08-26: three callers resolved to null while
 * the org's Foreman Claude subscription was connected and healthy — the feedback
 * automation gate (greyed toggle + "Connect Claude for Foreman" banner telling an
 * admin to do what they had already done), and both intake judges, which degraded
 * silently to "no credential" because the fail-safe below is indistinguishable
 * from a genuinely absent provider.
 *
 * EVERY module that calls resolveModelCredential must therefore
 * `import "@/lib/plugins/registry/server"` itself. That is enforced statically by
 * src/lib/ai/__tests__/model-credential-registration.arch.test.ts, so forgetting
 * it fails a test instead of silently disabling a feature.
 */
export function registerModelCredentialProvider(r: ModelCredentialResolver): void {
  resolver = r;
}

/** Resolve an org's model credential, or null (fail-safe: no provider ⇒ null,
 *  a provider that throws is swallowed to null so an intake judge never hard-fails). */
export async function resolveModelCredential(
  orgId: string,
): Promise<{ accessToken: string } | null> {
  if (!resolver) return null;
  try {
    return await resolver(orgId);
  } catch {
    return null;
  }
}
