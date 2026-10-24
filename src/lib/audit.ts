import { headers } from "next/headers";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { verifiedApiKeyId } from "@/lib/auth/api-key";

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
export type AuthMethod = "session" | "api_key";

/**
 * How the current request authenticated, and with which key. A key acts as the
 * user who minted it, so `userId` alone can't say whether a person did
 * something in the app or a script did it with their key; these fields can.
 *
 * Read from the same request headers authentication reads, so the ~200 call
 * sites of logAudit need no change. Nothing here trusts a header's claim: a
 * key is recorded only when its secret verifies (the check authentication
 * itself makes), so a signed-in user who adds someone's key prefix to a
 * request can't pin their write on that key. A bearer that doesn't verify
 * authenticated nothing, so the cookie decides. Outside a request (a job, a
 * script) there is nothing to record. OAuth tokens authenticate nothing yet;
 * they get a method of their own when they do.
 */
async function requestAuth(orgId: string): Promise<{ authMethod?: AuthMethod; apiKeyId?: string }> {
  let h: Headers;
  try {
    h = await headers();
  } catch {
    return {};
  }
  const keyId = await verifiedApiKeyId(h.get("authorization"), orgId);
  if (keyId) return { authMethod: "api_key", apiKeyId: keyId };
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
