import { headers } from "next/headers";
import { getCurrentUser, bearerIpAllowed } from "@/lib/auth/session";
import { classifyBearer } from "@/lib/auth/bearer";
import { verifyKeyTokenHolder } from "@/lib/auth/api-key";
import type { RouteContract } from "./contract";
import { assertScopes, servableApiVersion } from "./org-context";
import { API_VERSION_HEADER, resolveApiVersion } from "./version";
import { ProblemError } from "./problem";

/** The token a bearer caller presented, when there was one. */
export interface TokenInfo {
  orgId: string;
  scopes: string[];
  keyId: string;
  kind: "ORG" | "PERSONAL";
  expiresAt: Date | null;
  apiVersion: string;
}

/**
 * orgContext's counterpart for routes with no org in the path (`/me`,
 * `/orgs`): who is calling, by token or by session. A Cosmos bearer decides on
 * its own, never falling back to a cookie on the same request (bearer.ts).
 * A token is bound to one org, which the caller can see as `token.orgId`.
 */
export async function userContext(contract: Pick<RouteContract, "scopes">): Promise<{
  userId: string;
  token?: TokenInfo;
  apiVersion: string;
}> {
  const requestHeaders = await headers();
  const authorization = requestHeaders.get("authorization");
  const requested = requestHeaders.get(API_VERSION_HEADER);
  const bearer = classifyBearer(authorization);
  if (bearer !== null) {
    const holder = bearer === "api_key" ? await verifyKeyTokenHolder(authorization) : null;
    if (!holder || !(await bearerIpAllowed(holder.orgId))) throw new ProblemError(401, "unauthorized");
    assertScopes({ scopes: holder.scopes }, contract);
    const { userId, ...token } = holder;
    return { userId, token, apiVersion: servableApiVersion(resolveApiVersion(requested, token.apiVersion)) };
  }
  const user = await getCurrentUser();
  if (!user) throw new ProblemError(401, "unauthorized");
  return { userId: user.id, apiVersion: servableApiVersion(resolveApiVersion(requested)) };
}
