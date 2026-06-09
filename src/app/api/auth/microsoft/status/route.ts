import { NextResponse } from "next/server";
import { connection } from "next/server";
import { getProviderStatus } from "@/lib/auth/provider-config";

/** Public probe so the login page shows the Microsoft button only when an admin
 *  has configured + enabled the provider. `connection()` forces request-time
 *  evaluation (Cache Components would otherwise prerender this static). */
export async function GET() {
  await connection();
  const { configured, enabled } = await getProviderStatus("microsoft");
  return NextResponse.json({ configured: configured && enabled });
}
