/**
 * Model-credential provider seam (ADR 0003 decoupling, P1.5).
 *
 * Core's feedback-intake judges (duplicate detection + scope classification in
 * intake-guardrails.ts, and the security judge) need a model credential to run an
 * LLM turn. That credential used to come from Foreman's per-org Claude subscription
 * via a direct `@/lib/ai/foreman-claude-subscription` import — a core→Foreman
 * coupling that blocks extracting Foreman to its own repo.
 *
 * This registry inverts it: core resolves the credential through
 * `resolveModelCredential`, and whoever OWNS the credential (Foreman today, the
 * Foreman plugin after the split) registers a provider. FAIL-SAFE by construction:
 * when no provider is registered (Foreman absent / not enabled) the resolver returns
 * null and the intake judges degrade gracefully — exactly today's behavior when the
 * subscription is unavailable. It never throws.
 */

/** Resolves an org's model credential for internal AI, or null when unavailable. */
export type ModelCredentialResolver = (
  orgId: string,
) => Promise<{ accessToken: string } | null>;

let resolver: ModelCredentialResolver | null = null;

/** Register the process-wide credential provider (idempotent — last write wins).
 *  Called once at server boot by whoever owns the credential (see
 *  src/lib/foreman/server-boot.ts today; the Foreman plugin's server hooks post-split). */
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
