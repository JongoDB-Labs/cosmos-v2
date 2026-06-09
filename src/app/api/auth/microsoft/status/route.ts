import { NextResponse } from "next/server";
import { microsoftConfigured } from "@/lib/auth/microsoft";

/** Public probe so the login page can show the Microsoft button only when the
 *  Entra app credentials are configured. */
export async function GET() {
  return NextResponse.json({ configured: microsoftConfigured() });
}
