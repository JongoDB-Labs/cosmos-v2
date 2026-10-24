import { headers } from "next/headers";
import { getCurrentUser, bearerIpAllowed } from "@/lib/auth/session";
import { classifyBearer } from "@/lib/auth/bearer";
import { verifyKeyTokenHolder } from "@/lib/auth/api-key";
import type { RouteContract } from "./contract";
import { assertScopes } from "./org-context";
import { ProblemError } from "./problem";

/** The token a bearer caller presented, when there was one. */
export interface TokenInfo {
  orgId: string;
  scopes: string[];
  keyId: string;
  kind: "ORG" | "PERSONAL";
  expiresAt: Date | null;
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
}> {
  const authorization = (await headers()).get("authorization");
  const bearer = classifyBearer(authorization);
  if (bearer !== null) {
    const holder = bearer === "api_key" ? await verifyKeyTokenHolder(authorization) : null;
    if (!holder || !(await bearerIpAllowed(holder.orgId))) throw new ProblemError(401, "unauthorized");
    // Who-am-I operations (/me, /orgs) name no scope: any valid token may ask
    // who holds it. One that names scopes is held to them like any route.
    if (contract.scopes.length) assertScopes({ isApiKey: true, scopes: holder.scopes }, contract);
    const { userId, ...token } = holder;
    return { userId, token };
  }
  const user = await getCurrentUser();
  if (!user) throw new ProblemError(401, "unauthorized");
  return { userId: user.id };
}
