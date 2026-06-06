import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export async function GET() {
  const startTime = Date.now();
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return NextResponse.json(
    {
      ok: dbOk,
      db: dbOk ? "up" : "down",
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
    },
    { status: dbOk ? 200 : 503 },
  );
}
