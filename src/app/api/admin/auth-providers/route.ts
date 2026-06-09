import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getProviderStatus,
  setProviderConfig,
  type AuthProvider,
} from "@/lib/auth/provider-config";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";

const PROVIDERS: AuthProvider[] = ["microsoft"];

export async function GET() {
  const me = await requireSystemAdmin();
  if (!me) return new Response("Forbidden", { status: 403 });
  const providers: Record<string, { configured: boolean; enabled: boolean }> = {};
  for (const p of PROVIDERS) providers[p] = await getProviderStatus(p);
  return NextResponse.json({ providers });
}

const putSchema = z.object({
  provider: z.enum(["microsoft"]),
  clientId: z.string().min(1).max(200),
  // Optional: blank means "keep the existing secret" (so you can edit clientId
  // or toggle enabled without re-typing it).
  clientSecret: z.string().max(500).optional(),
  tenant: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function PUT(request: NextRequest) {
  const me = await requireSystemAdmin();
  if (!me) return new Response("Forbidden", { status: 403 });

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
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
