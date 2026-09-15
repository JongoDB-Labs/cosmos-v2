import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getProviderStatus,
  setProviderConfig,
  type AuthProvider,
} from "@/lib/auth/provider-config";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";

const PROVIDERS: AuthProvider[] = ["microsoft", "google"];

export async function GET() {
  const me = await requireSystemAdmin();
  if (!me) return new Response("Forbidden", { status: 403 });
  // Includes the NON-SECRET clientId/tenant so the admin form can prefill; the
  // sealed clientSecret is never returned. Admin-gated by requireSystemAdmin above.
  const providers: Record<
    string,
    { configured: boolean; enabled: boolean; clientId: string | null; tenant: string | null }
  > = {};
  for (const p of PROVIDERS) providers[p] = await getProviderStatus(p);
  return NextResponse.json({ providers });
}

const putSchema = z
  .object({
    provider: z.enum(["microsoft", "google"]),
    clientId: z.string().min(1).max(200),
    // Optional: blank means "keep the existing secret" (so you can edit clientId
    // or toggle enabled without re-typing it).
    clientSecret: z.string().max(500).optional(),
    tenant: z.string().max(200).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  // Microsoft REQUIRES a tenant. A blank one falls back to the /common endpoint
  // (see microsoftTenant in lib/auth/microsoft), which single-tenant app
  // registrations reject at the authorize step with AADSTS50194 — and because the
  // callback discards Entra's error params, that surfaces to the user as the
  // misleading "Sign-in expired". Google has no tenant concept, so this is
  // conditional rather than a plain required field.
  .refine((v) => v.provider !== "microsoft" || (v.tenant?.trim().length ?? 0) > 0, {
    path: ["tenant"],
    message:
      "A tenant is required for Microsoft — use the Directory (tenant) ID, a domain, or \"common\" only if the app registration is multi-tenant.",
  });

export async function PUT(request: NextRequest) {
  const me = await requireSystemAdmin();
  if (!me) return new Response("Forbidden", { status: 403 });

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // Surface WHICH field failed. A bare "Invalid request." made a missing tenant
    // indistinguishable from a malformed body during setup.
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid request." },
      { status: 400 },
    );
  }
  const { provider, clientId, clientSecret, tenant, enabled } = parsed.data;
  try {
    await setProviderConfig(
      provider,
      { clientId, clientSecret, tenant, enabled },
      me.id,
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Couldn't save provider." },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
