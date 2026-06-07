// src/lib/runtime-config/guardrails.ts
//
// GOV GUARDRAILS for the runtime config (design §8). A GOV-class org's connector/agent
// surface is HARDENED automatically: on a flip TO gov (platform-owner only) — and re-asserted
// on every tenant-admin PATCH — the runtime config is forced to a gov-safe posture:
//   - breadthEnabled = false   (no Nango/commercial breadth)
//   - mcpEnabled     = false   (external MCP off)
//   - enabledConnectors stripped of every COMMERCIAL-ONLY provider (Nango today)
//
// These are DEFENSE IN DEPTH on top of controls that ALREADY block gov from breadth: the
// connector availability rule (a commercial-only connector is excluded from a gov tool list
// + refused at dispatch + hard-checked in the executor + 403'd at the connect route), and
// the egress gov default-deny. The guardrails make the STORED config itself gov-safe so the
// GUI never shows breadth as on, and a later flip back to commercial doesn't silently
// re-expose a stale toggle.
//
// IDEMPOTENT: applying twice is a no-op (the second pass already finds breadth/mcp off and
// no commercial-only providers to strip). Safe to call on every PATCH.

import type { Prisma } from "@prisma/client";
import { commercialOnlyProviders } from "@/lib/ai/connectors";

/** A minimal Prisma client/transaction surface — accepts either the global client or a
 *  `$transaction` callback's `tx`, so the tenant-class route can run it in ONE txn. */
type RuntimeConfigDb = {
  orgRuntimeConfig: {
    findUnique(args: { where: { orgId: string } }): Promise<{
      enabledConnectors: string[];
    } | null>;
    upsert(args: {
      where: { orgId: string };
      create: Prisma.OrgRuntimeConfigUncheckedCreateInput;
      update: Prisma.OrgRuntimeConfigUncheckedUpdateInput;
    }): Promise<unknown>;
  };
};

/**
 * Force an org's runtime config into the gov-safe posture. Upserts the row (so an org with
 * no config still gets an explicit gov-safe row) with breadth+mcp OFF and every
 * commercial-only provider removed from `enabledConnectors`.
 *
 * Pass a transaction client (`tx`) to make this atomic with a tenantClass flip.
 */
export async function applyGovGuardrails(orgId: string, db: RuntimeConfigDb): Promise<void> {
  const breadthProviders = new Set(commercialOnlyProviders());
  const existing = await db.orgRuntimeConfig.findUnique({ where: { orgId } });
  const strippedConnectors = (existing?.enabledConnectors ?? []).filter((p) => !breadthProviders.has(p));

  await db.orgRuntimeConfig.upsert({
    where: { orgId },
    create: {
      orgId,
      // A brand-new gov row: keep allowlist OFF (all NATIVE connectors enabled — breadth is
      // separately forced off below + blocked by availability), breadth/mcp off.
      allowlistEnabled: false,
      enabledConnectors: [],
      breadthEnabled: false,
      mcpEnabled: false,
    },
    update: {
      breadthEnabled: false,
      mcpEnabled: false,
      // Strip commercial-only providers from any explicit allowlist (no-op when none present
      // ⇒ idempotent). When allowlist is OFF the array is ignored anyway; keeping it clean
      // means a later flip back to commercial doesn't resurface a stale breadth provider.
      enabledConnectors: strippedConnectors,
    },
  });
}

/**
 * Would a tenant-admin PATCH VIOLATE the gov guardrails? Pure predicate the runtime-config
 * route uses to REJECT (400) a gov org's attempt to re-enable breadth/mcp or list a
 * commercial-only connector. `tenantClass` is the org's CURRENT class ("GOV" | "COMMERCIAL").
 * Returns a human-readable reason, or null if the patch is allowed.
 */
export function govGuardrailViolation(
  tenantClass: string,
  patch: { breadthEnabled?: boolean; mcpEnabled?: boolean; enabledConnectors?: string[] | null },
): string | null {
  if (tenantClass !== "GOV") return null; // commercial may toggle freely.
  if (patch.breadthEnabled === true) {
    return "A GOV-class org cannot enable connector breadth (Nango) — it is disabled by the gov guardrails.";
  }
  if (patch.mcpEnabled === true) {
    return "A GOV-class org cannot enable external MCP — it is disabled by the gov guardrails.";
  }
  if (patch.enabledConnectors != null) {
    const breadthProviders = new Set(commercialOnlyProviders());
    const offending = patch.enabledConnectors.filter((p) => breadthProviders.has(p));
    if (offending.length > 0) {
      return `A GOV-class org cannot enable commercial-only connector(s): ${offending.join(", ")}.`;
    }
  }
  return null;
}
