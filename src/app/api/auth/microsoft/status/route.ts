import { NextResponse } from "next/server";
import { connection } from "next/server";
import { microsoftConfigured } from "@/lib/auth/microsoft";

/** Public probe so the login page can show the Microsoft button only when the
 *  Entra app credentials are configured. `connection()` forces request-time
 *  evaluation so this reflects the live env (creds can be set after the build);
 *  without it the route prerenders static and freezes the build-time value. */
export async function GET() {
  await connection();
  return NextResponse.json({ configured: microsoftConfigured() });
}
