import { headers } from "next/headers";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { classifyBearer, parseKeyToken } from "@/lib/auth/bearer";

export interface AuditEntry {
  orgId: string;
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string;
}

/** How the request behind an audited action authenticated. */
export type AuthMethod = "session" | "api_key" | "oauth";

/**
 * How the current request authenticated, and with which key. A key acts as the
 * user who minted it, so `userId` alone can't say whether a person did
 * something in the app or a script did it with their key; these fields can.
 *
 * Read from the request itself, so the ~200 call sites of logAudit need no
 * change. A bearer decides a request whenever it is present (it never falls
 * back to the cookie riding beside it), so it is checked first. Outside a
 * request (a job, a script) there is nothing to record.
 */
async function requestAuth(orgId: string): Promise<{ authMethod?: AuthMethod; apiKeyId?: string }> {
  let h: Headers;
  try {
    h = await headers();
  } catch {
    return {};
  }
  const authorization = h.get("authorization");
  const kind = classifyBearer(authorization);
  if (kind === "api_key") {
    const parsed = parseKeyToken(authorization);
    const key = parsed
      ? await prisma.apiKey.findUnique({ where: { orgId_prefix: { orgId, prefix: parsed.prefix } }, select: { id: true } })
      : null;
    return { authMethod: "api_key", ...(key && { apiKeyId: key.id }) };
  }
  if (kind === "oauth_access") return { authMethod: "oauth" };
  if (kind) return {};
  const cookie = h.get("cookie") ?? "";
  return new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=`).test(cookie) ? { authMethod: "session" } : {};
}

const isRecord = (v: unknown): v is Record<string, Prisma.InputJsonValue> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export async function logAudit(entry: AuditEntry) {
  const auth = await requestAuth(entry.orgId);
  // Recorded beside the caller's own metadata, which wins on a clash; a
  // non-object metadata value is kept as it was.
  const metadata = entry.metadata === undefined || isRecord(entry.metadata)
    ? { ...auth, ...(entry.metadata ?? {}) }
    : entry.metadata;
  await prisma.auditLog.create({
    data: {
      orgId: entry.orgId,
      userId: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      metadata,
      ipAddress: entry.ipAddress ?? null,
    },
  });
}
